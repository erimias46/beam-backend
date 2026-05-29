// Integration tests for /api/reviews and /api/customer-ratings (spec 0021).

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

async function seedPaidBooking(customer, barber) {
  const { rows } = await testPool.query(
    `INSERT INTO bookings (customer_id, barber_id, address, scheduled_at, service_type, price_cents, status)
     VALUES ($1, $2, '1 Test St', $3, 'Fade', 4000, 'paid') RETURNING *`,
    [customer.id, barber.id, FUTURE()]
  )
  return rows[0]
}

/* ─── GET /api/reviews/barber/:id ─────────────────────── */

test('GET /api/reviews/barber/:id — returns reviews for barber', { skip }, async () => {
  await resetDb()
  const barber = await seedBarber()
  const app    = await getApp()
  const r      = await request(app).get(`/api/reviews/barber/${barber.id}`)
  assert.equal(r.status, 200)
  const reviews = r.body.reviews ?? r.body
  assert.ok(Array.isArray(reviews))
})

test('GET /api/reviews/barber/:id — non-existent barber returns 200 empty or 404', { skip }, async () => {
  await resetDb()
  const app = await getApp()
  const r   = await request(app).get('/api/reviews/barber/00000000-0000-0000-0000-000000000000')
  assert.ok(r.status === 200 || r.status === 404)
})

/* ─── POST /api/reviews — customer reviews barber ─────── */

test('POST /api/reviews — customer can review a paid booking', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedPaidBooking(customer, barber)
  const app      = await getApp()
  const r        = await request(app)
    .post('/api/reviews')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ booking_id: booking.id, rating: 5, comment: 'Excellent cut!' })
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body))
})

test('POST /api/reviews — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal(
    (await request(app).post('/api/reviews').send({ booking_id: 'x', rating: 5 })).status,
    401
  )
})

test('POST /api/reviews — rating above 5 returns 400', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedPaidBooking(customer, barber)
  const app      = await getApp()
  const r        = await request(app)
    .post('/api/reviews')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ booking_id: booking.id, rating: 6 })
  assert.equal(r.status, 400, JSON.stringify(r.body))
})

test('POST /api/reviews — rating below 1 returns 400', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedPaidBooking(customer, barber)
  const app      = await getApp()
  const r        = await request(app)
    .post('/api/reviews')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ booking_id: booking.id, rating: 0 })
  assert.equal(r.status, 400, JSON.stringify(r.body))
})

test('POST /api/reviews — barber role returns 403 (customer-only)', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedPaidBooking(customer, barber)
  const app      = await getApp()
  const r        = await request(app)
    .post('/api/reviews')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({ booking_id: booking.id, rating: 5 })
  assert.equal(r.status, 403)
})

test('POST /api/reviews — review appears in barber GET', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedPaidBooking(customer, barber)
  const app      = await getApp()
  await request(app)
    .post('/api/reviews')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ booking_id: booking.id, rating: 4, comment: 'Great service' })
  const r       = await request(app).get(`/api/reviews/barber/${barber.id}`)
  const reviews = r.body.reviews ?? r.body
  assert.ok(reviews.some(rv => rv.booking_id === booking.id || rv.rating === 4))
})

/* ─── GET /api/customer-ratings/me ───────────────────── */

test('GET /api/customer-ratings/me — customer can view own rating', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()
  const r        = await request(app)
    .get('/api/customer-ratings/me')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.equal(r.status, 200)
})

test('GET /api/customer-ratings/me — barber returns 403 (customer-only)', { skip }, async () => {
  await resetDb()
  const barber = await seedBarber()
  const app    = await getApp()
  const r      = await request(app)
    .get('/api/customer-ratings/me')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
  assert.equal(r.status, 403)
})

/* ─── POST /api/customer-ratings — barber rates customer ─ */

test('POST /api/customer-ratings — barber can rate customer on paid booking', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedPaidBooking(customer, barber)
  const app      = await getApp()
  const r        = await request(app)
    .post('/api/customer-ratings')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({ booking_id: booking.id, rating: 4, tags: ['on_time'] })
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body))
})

test('POST /api/customer-ratings — customer cannot rate (barber-only)', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedPaidBooking(customer, barber)
  const app      = await getApp()
  const r        = await request(app)
    .post('/api/customer-ratings')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ booking_id: booking.id, rating: 4 })
  assert.equal(r.status, 403)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
