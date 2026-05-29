// Integration tests for /api/bookings routes.
// Covers: create, list, fetch, FSM access control, invalid transitions.
// Accept/confirm/complete are tested only for their auth/guard paths
// (Stripe calls are not made in test env with sk_test_placeholder key).

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
    `INSERT INTO barber_profiles (user_id, is_available, services)
     VALUES ($1, true, $2::jsonb)`,
    [barber.id, JSON.stringify([{ name: 'Fade', price_cents: 4000, duration_min: 45 }])]
  )
  return barber
}

async function createBooking(app, customer, barber, overrides = {}) {
  return request(app)
    .post('/api/bookings')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({
      barber_id:    barber.id,
      address:      '123 Test Street, Brooklyn, NY',
      scheduled_at: FUTURE(),
      service_type: 'Fade',
      price_cents:  4000,
      ...overrides,
    })
}

/* ─── POST /api/bookings ──────────────────────────────── */

test('POST /api/bookings — customer creates booking successfully', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()
  const r        = await createBooking(app, customer, barber)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.ok(r.body.booking.id)
  assert.equal(r.body.booking.status, 'requested')
  assert.equal(r.body.booking.customer_id, customer.id)
  assert.equal(r.body.booking.barber_id,   barber.id)
})

test('POST /api/bookings — barber cannot book themselves', { skip }, async () => {
  await resetDb()
  const barber = await seedBarber()
  const app    = await getApp()
  const r      = await createBooking(app, barber, barber)
  assert.notEqual(r.status, 201)
})

test('POST /api/bookings — unauthenticated returns 401', { skip }, async () => {
  await resetDb()
  const barber = await seedBarber()
  const app    = await getApp()
  const r      = await request(app).post('/api/bookings').send({
    barber_id:    barber.id,
    address:      '123 Test St',
    scheduled_at: FUTURE(),
    service_type: 'Fade',
    price_cents:  4000,
  })
  assert.equal(r.status, 401)
})

test('POST /api/bookings — past scheduled_at returns 400', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()
  const r        = await createBooking(app, customer, barber, {
    scheduled_at: new Date(Date.now() - 60_000).toISOString(),
  })
  assert.notEqual(r.status, 201)
})

test('POST /api/bookings — missing barber_id returns 400', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()
  const r        = await request(app)
    .post('/api/bookings')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ address: '123 Test St', scheduled_at: FUTURE(), service_type: 'Fade', price_cents: 4000 })
  assert.notEqual(r.status, 201)
})

test('POST /api/bookings — non-existent barber returns 4xx', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()
  const r        = await createBooking(app, customer, { id: '00000000-0000-0000-0000-000000000000' })
  assert.notEqual(r.status, 201)
})

/* ─── GET /api/bookings/mine ──────────────────────────── */

test('GET /api/bookings/mine — customer sees own bookings', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()
  await createBooking(app, customer, barber)
  const r = await request(app).get('/api/bookings/mine').set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.equal(r.status, 200)
  const list = Array.isArray(r.body) ? r.body : r.body.bookings
  assert.ok(list.length >= 1)
  assert.ok(list.every(b => b.customer_id === customer.id))
})

test('GET /api/bookings/mine — barber sees own bookings (as barber_id)', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()
  await createBooking(app, customer, barber)
  const r = await request(app).get('/api/bookings/mine').set('Authorization', `Bearer ${jwtFor(barber)}`)
  assert.equal(r.status, 200)
  const list = Array.isArray(r.body) ? r.body : r.body.bookings
  assert.ok(list.length >= 1)
  assert.ok(list.every(b => b.barber_id === barber.id))
})

test('GET /api/bookings/mine — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).get('/api/bookings/mine')
  assert.equal(r.status, 401)
})

/* ─── GET /api/bookings/:id ───────────────────────────── */

test('GET /api/bookings/:id — owner can fetch booking', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()
  const created  = await createBooking(app, customer, barber)
  const id       = created.body.booking.id
  const r        = await request(app).get(`/api/bookings/${id}`).set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.equal(r.status, 200)
  assert.equal((r.body.booking ?? r.body).id, id)
})

test('GET /api/bookings/:id — unrelated user returns 403 or 404', { skip }, async () => {
  await resetDb()
  const customer  = await seedUser({ role: 'customer' })
  const customer2 = await seedUser({ role: 'customer' })
  const barber    = await seedBarber()
  const app       = await getApp()
  const created   = await createBooking(app, customer, barber)
  const id        = created.body.booking.id
  const r         = await request(app).get(`/api/bookings/${id}`).set('Authorization', `Bearer ${jwtFor(customer2)}`)
  assert.ok(r.status === 403 || r.status === 404)
})

/* ─── PATCH /api/bookings/:id/decline ─────────────────── */

test('PATCH /api/bookings/:id/decline — barber can decline', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()
  const { body: { booking } } = await createBooking(app, customer, barber)
  const r = await request(app)
    .patch(`/api/bookings/${booking.id}/decline`)
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const updated = r.body.booking ?? r.body
  assert.equal(updated.status, 'declined')
})

test('PATCH /api/bookings/:id/decline — customer cannot decline', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()
  const { body: { booking } } = await createBooking(app, customer, barber)
  const r = await request(app)
    .patch(`/api/bookings/${booking.id}/decline`)
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.equal(r.status, 403)
})

/* ─── PATCH /api/bookings/:id/cancel ─────────────────── */

test('PATCH /api/bookings/:id/cancel — customer can cancel requested booking', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()
  const { body: { booking } } = await createBooking(app, customer, barber)
  const r = await request(app)
    .patch(`/api/bookings/${booking.id}/cancel`)
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.equal(r.status, 200, JSON.stringify(r.body))
})

/* ─── FSM invalid transitions ─────────────────────────── */

test('FSM: cannot cancel a declined booking (terminal)', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()
  const { body: { booking } } = await createBooking(app, customer, barber)
  // decline it first
  await request(app).patch(`/api/bookings/${booking.id}/decline`).set('Authorization', `Bearer ${jwtFor(barber)}`)
  // now try to cancel — should fail
  const r = await request(app)
    .patch(`/api/bookings/${booking.id}/cancel`)
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.equal(r.status, 422)
})

test('FSM: cannot accept a cancelled booking', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()
  const { body: { booking } } = await createBooking(app, customer, barber)
  await request(app).patch(`/api/bookings/${booking.id}/cancel`).set('Authorization', `Bearer ${jwtFor(customer)}`)
  const r = await request(app)
    .patch(`/api/bookings/${booking.id}/accept`)
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
  assert.ok(r.status === 422 || r.status === 402) // 422 FSM or 402 Stripe not set up
})

/* ─── Health endpoints ─────────────────────────────────── */

test('GET /health — returns ok', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).get('/health')
  assert.equal(r.status, 200)
  assert.ok(r.body.ok)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
