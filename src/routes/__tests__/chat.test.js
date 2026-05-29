// Integration tests for /api/bookings/:id/messages (spec 0030).

import test from 'node:test'
import assert from 'node:assert/strict'
import { pointAppPoolAtTestDb, resetDb, seedUser, closeAll, testPool } from '../../__tests__/helpers/db.js'

pointAppPoolAtTestDb()
process.env.MASTER_OTP = '000000'

const { getApp, jwtFor } = await import('../../__tests__/helpers/app.js')
const request = (await import('supertest')).default
const dbOk = await testPool.query('SELECT 1').then(() => true).catch(() => false)
const skip  = !dbOk

const FUTURE = () => new Date(Date.now() + 2 * 60 * 60_000).toISOString()

async function seedBarber() {
  const barber = await seedUser({ role: 'barber' })
  await testPool.query(
    `INSERT INTO barber_profiles (user_id, is_available, services) VALUES ($1, true, $2::jsonb)`,
    [barber.id, JSON.stringify([{ name: 'Fade', price_cents: 4000, duration_min: 45 }])]
  )
  return barber
}

async function seedAcceptedBooking(customer, barber) {
  const { rows } = await testPool.query(
    `INSERT INTO bookings (customer_id, barber_id, address, scheduled_at, service_type, price_cents, status)
     VALUES ($1, $2, '1 Test St', $3, 'Fade', 4000, 'accepted') RETURNING *`,
    [customer.id, barber.id, FUTURE()]
  )
  return rows[0]
}

/* ─── GET /api/bookings/:id/messages ─────────────────── */

test('GET /api/bookings/:id/messages — returns empty list initially', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedAcceptedBooking(customer, barber)
  const app      = await getApp()
  const r        = await request(app)
    .get(`/api/bookings/${booking.id}/messages`)
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.equal(r.status, 200)
  const msgs = r.body.messages ?? r.body
  assert.ok(Array.isArray(msgs))
  assert.equal(msgs.length, 0)
})

test('GET /api/bookings/:id/messages — unauthenticated returns 401', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedAcceptedBooking(customer, barber)
  const app      = await getApp()
  assert.equal((await request(app).get(`/api/bookings/${booking.id}/messages`)).status, 401)
})

test('GET /api/bookings/:id/messages — unrelated user returns 403', { skip }, async () => {
  await resetDb()
  const customer  = await seedUser({ role: 'customer' })
  const customer2 = await seedUser({ role: 'customer' })
  const barber    = await seedBarber()
  const booking   = await seedAcceptedBooking(customer, barber)
  const app       = await getApp()
  const r = await request(app)
    .get(`/api/bookings/${booking.id}/messages`)
    .set('Authorization', `Bearer ${jwtFor(customer2)}`)
  assert.ok(r.status === 403 || r.status === 404)
})

/* ─── POST /api/bookings/:id/messages ────────────────── */

test('POST /api/bookings/:id/messages — customer can send message', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedAcceptedBooking(customer, barber)
  const app      = await getApp()
  const r        = await request(app)
    .post(`/api/bookings/${booking.id}/messages`)
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ body: 'Hey, I am on my way!' })
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body))
})

test('POST /api/bookings/:id/messages — barber can send message', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedAcceptedBooking(customer, barber)
  const app      = await getApp()
  const r        = await request(app)
    .post(`/api/bookings/${booking.id}/messages`)
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({ body: 'I am 5 minutes away!' })
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body))
})

test('POST /api/bookings/:id/messages — message appears in GET list', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedAcceptedBooking(customer, barber)
  const app      = await getApp()
  await request(app)
    .post(`/api/bookings/${booking.id}/messages`)
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ body: 'Hello there!' })
  const r    = await request(app)
    .get(`/api/bookings/${booking.id}/messages`)
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  const msgs = r.body.messages ?? r.body
  assert.ok(msgs.some(m => m.body === 'Hello there!'))
})

test('POST /api/bookings/:id/messages — empty body returns 400', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedAcceptedBooking(customer, barber)
  const app      = await getApp()
  const r        = await request(app)
    .post(`/api/bookings/${booking.id}/messages`)
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ body: '' })
  assert.ok(r.status >= 400)
})

test('POST /api/bookings/:id/messages — unauthenticated returns 401', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedAcceptedBooking(customer, barber)
  const app      = await getApp()
  assert.equal(
    (await request(app).post(`/api/bookings/${booking.id}/messages`).send({ body: 'hi' })).status,
    401
  )
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
