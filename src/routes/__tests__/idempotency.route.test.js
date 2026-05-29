// Route-level test for the idempotency middleware (spec 0010).
//
// Closes the "deferred" criteria in 0010:
//   - double-tap POST /api/bookings → exactly one booking row
//   - same key + different body → 409 idempotency_key_reused
//   - missing key → legacy behavior (two requests = two rows)
//
// Requires:
//   - A running Postgres at TEST_DATABASE_URL (or DATABASE_URL pointing at a
//     test DB). The helper auto-runs migrations once per process.
//   - No Stripe key set — POST /api/bookings does not call Stripe (PI is
//     created later in /accept).
//
// Skips automatically if the test DB isn't reachable. CI will set the env var.

import test from 'node:test'
import assert from 'node:assert/strict'
import { pointAppPoolAtTestDb, resetDb, seedUser, testPool, closeAll } from '../../__tests__/helpers/db.js'

// Must happen before importing the app so the prod pool reads our TEST_DATABASE_URL.
pointAppPoolAtTestDb()

const { getApp, jwtFor } = await import('../../__tests__/helpers/app.js')
let request

try {
  request = (await import('supertest')).default
} catch {
  console.warn('[route test] supertest not installed — skipping. Run `npm install` first.')
}

const dbReachable = await testPool.query('SELECT 1').then(() => true).catch(() => false)

test('[route] POST /api/bookings — double-tap with same key creates one row', { skip: !request || !dbReachable }, async () => {
  await resetDb()

  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedUser({ role: 'barber' })
  await testPool.query(
    `INSERT INTO barber_profiles (user_id, is_available, services) VALUES ($1, true, $2::jsonb)`,
    [barber.id, JSON.stringify([{ name: 'Fade', price_cents: 4000, duration_min: 30 }])]
  )

  const app = await getApp()
  const token = jwtFor(customer)
  const key = '11111111-2222-3333-4444-555555555555'
  const body = {
    barber_id:    barber.id,
    address:      '123 Test Street, Brooklyn, NY',
    scheduled_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    service_type: 'Fade',
    price_cents:  4000,
  }

  const r1 = await request(app).post('/api/bookings')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(body)
  assert.equal(r1.status, 201, `first request: ${JSON.stringify(r1.body)}`)

  const r2 = await request(app).post('/api/bookings')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(body)
  assert.equal(r2.status, 201, `replay should match original: ${JSON.stringify(r2.body)}`)
  assert.equal(r2.body.booking.id, r1.body.booking.id, 'same booking ID returned on replay')

  const count = await testPool.query(`SELECT COUNT(*)::int AS n FROM bookings WHERE customer_id = $1`, [customer.id])
  assert.equal(count.rows[0].n, 1, 'only one booking row created')
})

test('[route] POST /api/bookings — same key + different body returns 409', { skip: !request || !dbReachable }, async () => {
  await resetDb()

  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedUser({ role: 'barber' })
  await testPool.query(
    `INSERT INTO barber_profiles (user_id, is_available, services) VALUES ($1, true, $2::jsonb)`,
    [barber.id, JSON.stringify([{ name: 'Fade', price_cents: 4000, duration_min: 30 }])]
  )

  const app = await getApp()
  const token = jwtFor(customer)
  const key = '99999999-8888-7777-6666-555555555555'
  const base = {
    barber_id:    barber.id,
    address:      '123 Test Street, Brooklyn, NY',
    scheduled_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    service_type: 'Fade',
    price_cents:  4000,
  }

  const r1 = await request(app).post('/api/bookings')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(base)
  assert.equal(r1.status, 201)

  const r2 = await request(app).post('/api/bookings')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send({ ...base, price_cents: 5000 })
  assert.equal(r2.status, 409, `expected 409 reuse, got ${r2.status}: ${JSON.stringify(r2.body)}`)
  assert.equal(r2.body.error, 'idempotency_key_reused')
})

test('[route] POST /api/bookings — without Idempotency-Key, two requests create two rows', { skip: !request || !dbReachable }, async () => {
  await resetDb()

  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedUser({ role: 'barber' })
  await testPool.query(
    `INSERT INTO barber_profiles (user_id, is_available, services) VALUES ($1, true, $2::jsonb)`,
    [barber.id, JSON.stringify([{ name: 'Fade', price_cents: 4000, duration_min: 30 }])]
  )

  const app = await getApp()
  const token = jwtFor(customer)
  const body = (offsetMin) => ({
    barber_id:    barber.id,
    address:      '123 Test Street, Brooklyn, NY',
    scheduled_at: new Date(Date.now() + offsetMin * 60_000).toISOString(),
    service_type: 'Fade',
    price_cents:  4000,
  })

  // Legacy behavior is intentional: middleware is opt-in via header. Use
  // different scheduled_at so the barber's active-slot unique index doesn't
  // 409 the second request — that's a different protection (anti-double-book)
  // that this test isn't about.
  const r1 = await request(app).post('/api/bookings').set('Authorization', `Bearer ${token}`).send(body(60))
  const r2 = await request(app).post('/api/bookings').set('Authorization', `Bearer ${token}`).send(body(120))
  assert.equal(r1.status, 201, `r1: ${JSON.stringify(r1.body)}`)
  assert.equal(r2.status, 201, `r2: ${JSON.stringify(r2.body)}`)
  assert.notEqual(r1.body.booking.id, r2.body.booking.id)
})

test.after(async () => {
  await closeAll()
  // The app imports db/index.js (its own pool) and routes fire-and-forget
  // into BullMQ via scheduleAutoCancel. Both keep the process alive — close
  // them explicitly so node:test exits cleanly.
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue()
  await pool.end().catch(() => {})
})
