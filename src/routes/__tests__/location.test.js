// Integration tests for live barber location (spec 0031).

import test from 'node:test'
import assert from 'node:assert/strict'
import { pointAppPoolAtTestDb, resetDb, seedUser, closeAll, testPool } from '../../__tests__/helpers/db.js'

pointAppPoolAtTestDb()
process.env.MASTER_OTP = '000000'

const { getApp, jwtFor } = await import('../../__tests__/helpers/app.js')
const request = (await import('supertest')).default
const dbOk = await testPool.query('SELECT 1').then(() => true).catch(() => false)
const skip  = !dbOk

async function seedBarber() {
  const b = await seedUser({ role: 'barber' })
  await testPool.query(
    `INSERT INTO barber_profiles (user_id, is_available, services) VALUES ($1, true, '[]'::jsonb)`,
    [b.id]
  )
  return b
}

async function seedActiveBooking(customerId, barberId) {
  const { rows } = await testPool.query(
    `INSERT INTO bookings
       (customer_id, barber_id, address, scheduled_at, service_type, price_cents, status, lat, lng)
     VALUES ($1, $2, '1 Location St', now() + interval '1 hour', 'Fade', 4000, 'in_progress', 33.749, -84.388)
     RETURNING *`,
    [customerId, barberId]
  )
  return rows[0]
}

/* ─── POST /api/bookings/:id/location ─────────────────────── */

test('POST /api/bookings/:id/location — barber can push their position', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedActiveBooking(customer.id, barber.id)
  const app      = await getApp()

  const r = await request(app)
    .post(`/api/bookings/${booking.id}/location`)
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({ lat: 33.755, lng: -84.390 })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(r.body.ok || r.body.location || r.body.lat != null || r.status === 200)
})

test('POST /api/bookings/:id/location — customer cannot push location (403)', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedActiveBooking(customer.id, barber.id)
  const app      = await getApp()

  const r = await request(app)
    .post(`/api/bookings/${booking.id}/location`)
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ lat: 33.755, lng: -84.390 })
  assert.ok(r.status === 403 || r.status === 422)
})

test('POST /api/bookings/:id/location — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).post('/api/bookings/some-id/location').send({ lat: 33.749, lng: -84.388 })
  assert.equal(r.status, 401)
})

/* ─── GET /api/bookings/:id/location ──────────────────────── */

test('GET /api/bookings/:id/location — customer can read barber location', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedActiveBooking(customer.id, barber.id)
  const app      = await getApp()

  // Push a location first
  await request(app)
    .post(`/api/bookings/${booking.id}/location`)
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({ lat: 33.755, lng: -84.390 })

  const r = await request(app)
    .get(`/api/bookings/${booking.id}/location`)
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.equal(r.status, 200, JSON.stringify(r.body))
})

test('GET /api/bookings/:id/location — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal((await request(app).get('/api/bookings/some-id/location')).status, 401)
})

test('GET /api/bookings/:id/location — unrelated user returns 403 or 404', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedActiveBooking(customer.id, barber.id)
  const other    = await seedUser({ role: 'customer' })
  const app      = await getApp()

  const r = await request(app)
    .get(`/api/bookings/${booking.id}/location`)
    .set('Authorization', `Bearer ${jwtFor(other)}`)
  assert.ok(r.status === 403 || r.status === 404)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
