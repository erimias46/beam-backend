// End-to-end booking lifecycle integration test.
// Covers the full flow from signup → create booking → decline/cancel
// and the access-control matrix across roles.

import test from 'node:test'
import assert from 'node:assert/strict'
import { pointAppPoolAtTestDb, resetDb, seedUser, closeAll, testPool } from '../helpers/db.js'

pointAppPoolAtTestDb()
process.env.MASTER_OTP = '000000'

const { getApp, jwtFor } = await import('../helpers/app.js')
const request = (await import('supertest')).default

const dbOk = await testPool.query('SELECT 1').then(() => true).catch(() => false)
const skip  = !dbOk

const FUTURE = () => new Date(Date.now() + 2 * 60 * 60_000).toISOString()

async function seedBarber(overrides = {}) {
  const barber = await seedUser({ role: 'barber', ...overrides })
  await testPool.query(
    `INSERT INTO barber_profiles (user_id, is_available, services, bio, years_experience)
     VALUES ($1, true, $2::jsonb, 'Test bio', 5)`,
    [barber.id, JSON.stringify([
      { name: 'Fade',    price_cents: 4000, duration_min: 45 },
      { name: 'Lineup',  price_cents: 2500, duration_min: 20 },
    ])]
  )
  return barber
}

/* ─── Full signup → book → decline flow ───────────────── */

test('[lifecycle] customer signs up → books → barber declines', { skip }, async () => {
  await resetDb()
  const app = await getApp()

  // 1. Barber signs up via OTP
  const barberEmail = 'barber.lifecycle@beam0.example'
  await request(app).post('/api/auth/send-otp').send({ email: barberEmail })
  const barberAuth = await request(app).post('/api/auth/verify-otp').send({ email: barberEmail, code: '000000', role: 'barber' })
  assert.equal(barberAuth.status, 200, 'barber auth failed')
  const barberToken = barberAuth.body.token
  const barberId    = barberAuth.body.user.id

  // 2. Barber sets up profile
  await request(app)
    .post('/api/barbers/profile')
    .set('Authorization', `Bearer ${barberToken}`)
    .send({
      bio: 'Great barber', years_experience: 5,
      services: [{ name: 'Fade', price_cents: 4000, duration_min: 45 }],
    })

  // 3. Customer signs up
  const customerEmail = 'customer.lifecycle@beam0.example'
  await request(app).post('/api/auth/send-otp').send({ email: customerEmail })
  const custAuth = await request(app).post('/api/auth/verify-otp').send({ email: customerEmail, code: '000000', role: 'customer' })
  assert.equal(custAuth.status, 200, 'customer auth failed')
  const customerToken = custAuth.body.token

  // 4. Customer creates booking
  const bookR = await request(app)
    .post('/api/bookings')
    .set('Authorization', `Bearer ${customerToken}`)
    .send({
      barber_id:    barberId,
      address:      '123 Lifecycle Street, Atlanta, GA',
      scheduled_at: FUTURE(),
      service_type: 'Fade',
      price_cents:  4000,
    })
  assert.equal(bookR.status, 201, `booking failed: ${JSON.stringify(bookR.body)}`)
  const bookingId = bookR.body.booking.id
  assert.equal(bookR.body.booking.status, 'requested')

  // 5. Barber sees it in their list
  const barberList = await request(app)
    .get('/api/bookings/mine')
    .set('Authorization', `Bearer ${barberToken}`)
  const found = (barberList.body.bookings ?? barberList.body).find(b => b.id === bookingId)
  assert.ok(found, 'barber should see the booking in their list')

  // 6. Barber declines
  const declineR = await request(app)
    .patch(`/api/bookings/${bookingId}/decline`)
    .set('Authorization', `Bearer ${barberToken}`)
  assert.equal(declineR.status, 200, `decline failed: ${JSON.stringify(declineR.body)}`)
  const afterDecline = declineR.body.booking ?? declineR.body
  assert.equal(afterDecline.status, 'declined')

  // 7. Cannot decline again (terminal state)
  const declineAgain = await request(app)
    .patch(`/api/bookings/${bookingId}/decline`)
    .set('Authorization', `Bearer ${barberToken}`)
  assert.equal(declineAgain.status, 422)
})

/* ─── Customer cancels their own booking ─────────────────── */

test('[lifecycle] customer can cancel a pending booking', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()

  const bookR = await request(app)
    .post('/api/bookings')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({
      barber_id: barber.id, address: '456 Cancel St',
      scheduled_at: FUTURE(), service_type: 'Fade', price_cents: 4000,
    })
  assert.equal(bookR.status, 201)

  const cancelR = await request(app)
    .patch(`/api/bookings/${bookR.body.booking.id}/cancel`)
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.equal(cancelR.status, 200)
  const b = cancelR.body.booking ?? cancelR.body
  assert.equal(b.status, 'cancelled')
})

/* ─── Access control matrix ───────────────────────────── */

test('[access] unrelated customer cannot view another customer\'s booking', { skip }, async () => {
  await resetDb()
  const c1     = await seedUser({ role: 'customer' })
  const c2     = await seedUser({ role: 'customer' })
  const barber = await seedBarber()
  const app    = await getApp()

  const bookR = await request(app)
    .post('/api/bookings')
    .set('Authorization', `Bearer ${jwtFor(c1)}`)
    .send({ barber_id: barber.id, address: '789 Private St', scheduled_at: FUTURE(), service_type: 'Fade', price_cents: 4000 })

  const r = await request(app)
    .get(`/api/bookings/${bookR.body.booking.id}`)
    .set('Authorization', `Bearer ${jwtFor(c2)}`)
  assert.ok(r.status === 403 || r.status === 404)
})

test('[access] barber cannot cancel customer\'s booking', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()
  const bookR    = await request(app)
    .post('/api/bookings')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ barber_id: barber.id, address: '1 Test St', scheduled_at: FUTURE(), service_type: 'Fade', price_cents: 4000 })

  const r = await request(app)
    .patch(`/api/bookings/${bookR.body.booking.id}/cancel`)
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
  assert.ok(r.status === 403 || r.status === 422, `expected 403/422 but got ${r.status}`)
})

test('[access] customer cannot start a booking (barber-only action)', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()
  const bookR    = await request(app)
    .post('/api/bookings')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ barber_id: barber.id, address: '1 Test St', scheduled_at: FUTURE(), service_type: 'Fade', price_cents: 4000 })

  const r = await request(app)
    .patch(`/api/bookings/${bookR.body.booking.id}/start`)
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.equal(r.status, 403)
})

/* ─── Admin access ─────────────────────────────────────── */

test('[access] admin can view any booking', { skip }, async () => {
  await resetDb()
  const admin    = await seedUser({ role: 'admin' })
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()
  const bookR    = await request(app)
    .post('/api/bookings')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ barber_id: barber.id, address: '1 Admin St', scheduled_at: FUTURE(), service_type: 'Fade', price_cents: 4000 })

  const r = await request(app)
    .get(`/api/bookings/${bookR.body.booking.id}`)
    .set('Authorization', `Bearer ${jwtFor(admin)}`)
  assert.equal(r.status, 200)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
