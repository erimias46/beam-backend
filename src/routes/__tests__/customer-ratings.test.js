// Integration tests for barber→customer ratings (spec 0021).

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

/** Seed a booking in a rateable status (completed) between barber and customer. */
async function seedCompletedBooking(customerId, barberId) {
  const { rows } = await testPool.query(
    `INSERT INTO bookings
       (customer_id, barber_id, address, scheduled_at, service_type, price_cents, status)
     VALUES ($1, $2, '1 Rate St', now() - interval '1 hour', 'Fade', 4000, 'completed')
     RETURNING *`,
    [customerId, barberId]
  )
  return rows[0]
}

/* ─── POST /api/customer-ratings ─────────────────────────── */

test('POST /api/customer-ratings — barber can rate a customer', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedCompletedBooking(customer.id, barber.id)
  const app      = await getApp()

  const r = await request(app)
    .post('/api/customer-ratings')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({ booking_id: booking.id, rating: 5, tags: ['punctual'], notes: 'Great customer' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(r.body.rating)
  assert.equal(r.body.rating.rating, 5)
})

test('POST /api/customer-ratings — customer cannot rate (403)', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedCompletedBooking(customer.id, barber.id)
  const app      = await getApp()

  const r = await request(app)
    .post('/api/customer-ratings')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ booking_id: booking.id, rating: 5 })
  assert.equal(r.status, 403)
})

test('POST /api/customer-ratings — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).post('/api/customer-ratings').send({ booking_id: 'x', rating: 5 })
  assert.equal(r.status, 401)
})

test('POST /api/customer-ratings — invalid rating returns 400', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedCompletedBooking(customer.id, barber.id)
  const app      = await getApp()

  const r = await request(app)
    .post('/api/customer-ratings')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({ booking_id: booking.id, rating: 10 }) // out of range
  assert.equal(r.status, 400)
})

test('POST /api/customer-ratings — duplicate rating returns 409', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const booking  = await seedCompletedBooking(customer.id, barber.id)
  const app      = await getApp()

  await request(app)
    .post('/api/customer-ratings')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({ booking_id: booking.id, rating: 4 })

  const r = await request(app)
    .post('/api/customer-ratings')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({ booking_id: booking.id, rating: 3 })
  assert.equal(r.status, 409)
})

/* ─── GET /api/customer-ratings/me ───────────────────────── */

test('GET /api/customer-ratings/me — customer can see own aggregate', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()

  const r = await request(app)
    .get('/api/customer-ratings/me')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.equal(r.status, 200)
  assert.ok('count' in r.body, 'should have count field')
})

test('GET /api/customer-ratings/me — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal((await request(app).get('/api/customer-ratings/me')).status, 401)
})

/* ─── GET /api/customer-ratings/customer/:id ─────────────── */

test('GET /api/customer-ratings/customer/:id — barber can view customer rating', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()

  const r = await request(app)
    .get(`/api/customer-ratings/customer/${customer.id}`)
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
  assert.equal(r.status, 200)
  assert.ok('avg' in r.body)
  assert.ok('count' in r.body)
})

test('GET /api/customer-ratings/customer/:id — customer cannot view other customer rating (403)', { skip }, async () => {
  await resetDb()
  const c1  = await seedUser({ role: 'customer' })
  const c2  = await seedUser({ role: 'customer' })
  const app = await getApp()

  const r = await request(app)
    .get(`/api/customer-ratings/customer/${c2.id}`)
    .set('Authorization', `Bearer ${jwtFor(c1)}`)
  assert.equal(r.status, 403)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
