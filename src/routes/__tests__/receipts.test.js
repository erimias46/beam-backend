// Integration tests for receipts (spec 0043).
// GET /api/receipts/:token  — public receipt by token
// GET /api/bookings/:id/receipt — authed receipt

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
  const barber = await seedUser({ role: 'barber' })
  await testPool.query(
    `INSERT INTO barber_profiles (user_id, is_available, services) VALUES ($1, true, '[]'::jsonb)`,
    [barber.id]
  )
  return barber
}

async function seedBookingWithReceipt(customerId, barberId) {
  const { rows } = await testPool.query(
    `INSERT INTO bookings
       (customer_id, barber_id, address, scheduled_at, service_type, price_cents, status)
     VALUES ($1, $2, '1 Test St', now() + interval '2 hours', 'Fade', 4000, 'paid')
     RETURNING *`,
    [customerId, barberId]
  )
  return rows[0]
}

/* ─── GET /api/receipts/:token (public) ───────────────────── */

test('GET /api/receipts/:token — valid token returns receipt', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedBookingWithReceipt(customer.id, barber.id)
  const app      = await getApp()

  const r = await request(app).get(`/api/receipts/${booking.receipt_token}`)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(r.body.booking, 'response should have booking')
  assert.ok(r.body.amounts, 'response should have amounts')
  assert.equal(r.body.booking.id, booking.id)
})

test('GET /api/receipts/:token — invalid token returns 404', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).get('/api/receipts/invalid-token-that-does-not-exist')
  assert.equal(r.status, 404)
})

/* ─── GET /api/bookings/:id/receipt (authed) ─────────────── */

test('GET /api/bookings/:id/receipt — customer can view their receipt', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedBookingWithReceipt(customer.id, barber.id)
  const app      = await getApp()

  const r = await request(app)
    .get(`/api/bookings/${booking.id}/receipt`)
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.booking.id, booking.id)
  assert.equal(r.body.amounts.service_cents, 4000)
})

test('GET /api/bookings/:id/receipt — barber can view receipt for their booking', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedBookingWithReceipt(customer.id, barber.id)
  const app      = await getApp()

  const r = await request(app)
    .get(`/api/bookings/${booking.id}/receipt`)
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
  assert.equal(r.status, 200)
})

test('GET /api/bookings/:id/receipt — unrelated user returns 403', { skip }, async () => {
  await resetDb()
  const customer  = await seedUser({ role: 'customer' })
  const barber    = await seedBarber()
  const booking   = await seedBookingWithReceipt(customer.id, barber.id)
  const other     = await seedUser({ role: 'customer' })
  const app       = await getApp()

  const r = await request(app)
    .get(`/api/bookings/${booking.id}/receipt`)
    .set('Authorization', `Bearer ${jwtFor(other)}`)
  assert.equal(r.status, 403)
})

test('GET /api/bookings/:id/receipt — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).get('/api/bookings/some-id/receipt')
  assert.equal(r.status, 401)
})

test('GET /api/bookings/:id/receipt — non-existent booking returns 404', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .get('/api/bookings/00000000-0000-0000-0000-000000000000/receipt')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
  assert.equal(r.status, 404)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
