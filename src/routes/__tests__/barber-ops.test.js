// Integration tests for barber operations:
// weekly schedule, vacation, ping, service area, payouts.

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

/* ─── GET /api/barbers/me/schedule ───────────────────── */

test('GET /api/barbers/me/schedule — barber can fetch own schedule', { skip }, async () => {
  await resetDb()
  const barber = await seedBarber()
  const app    = await getApp()
  const r      = await request(app)
    .get('/api/barbers/me/schedule')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
  assert.equal(r.status, 200)
  const schedule = r.body.windows ?? r.body.schedule ?? r.body
  assert.ok(Array.isArray(schedule))
})

test('GET /api/barbers/me/schedule — customer returns 403', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()
  const r        = await request(app)
    .get('/api/barbers/me/schedule')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.equal(r.status, 403)
})

test('GET /api/barbers/me/schedule — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal((await request(app).get('/api/barbers/me/schedule')).status, 401)
})

/* ─── PUT /api/barbers/me/schedule ───────────────────── */

test('PUT /api/barbers/me/schedule — barber can update schedule', { skip }, async () => {
  await resetDb()
  const barber = await seedBarber()
  const app    = await getApp()
  const r      = await request(app)
    .put('/api/barbers/me/schedule')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({ windows: [
      { day_of_week: 1, start_minute: 540, end_minute: 1020 }, // Mon 9am-5pm
      { day_of_week: 2, start_minute: 540, end_minute: 1020 }, // Tue
      { day_of_week: 3, start_minute: 540, end_minute: 1020 }, // Wed
    ] })
  assert.equal(r.status, 200, JSON.stringify(r.body))
})

test('PUT /api/barbers/me/schedule — customer returns 403', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()
  const r        = await request(app)
    .put('/api/barbers/me/schedule')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send([])
  assert.equal(r.status, 403)
})

/* ─── PATCH /api/barbers/me/vacation ─────────────────── */

test('PATCH /api/barbers/me/vacation — barber can set vacation', { skip }, async () => {
  await resetDb()
  const barber = await seedBarber()
  const app    = await getApp()
  const until  = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString()
  const r      = await request(app)
    .patch('/api/barbers/me/vacation')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({ vacation_until: until })
  assert.equal(r.status, 200, JSON.stringify(r.body))
})

test('PATCH /api/barbers/me/vacation — barber can clear vacation (null)', { skip }, async () => {
  await resetDb()
  const barber = await seedBarber()
  const app    = await getApp()
  const r      = await request(app)
    .patch('/api/barbers/me/vacation')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({ vacation_until: null })
  assert.equal(r.status, 200)
})

test('PATCH /api/barbers/me/vacation — customer returns 403', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()
  assert.equal(
    (await request(app).patch('/api/barbers/me/vacation').set('Authorization', `Bearer ${jwtFor(customer)}`).send({ vacation_until: null })).status,
    403
  )
})

/* ─── POST /api/barbers/me/ping ──────────────────────── */

test('POST /api/barbers/me/ping — barber can ping to stay online', { skip }, async () => {
  await resetDb()
  const barber = await seedBarber()
  const app    = await getApp()
  const r      = await request(app)
    .post('/api/barbers/me/ping')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
  assert.equal(r.status, 200)
})

test('POST /api/barbers/me/ping — customer returns 403', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()
  assert.equal(
    (await request(app).post('/api/barbers/me/ping').set('Authorization', `Bearer ${jwtFor(customer)}`)).status,
    403
  )
})

/* ─── PATCH /api/barbers/me/service-area ─────────────── */

test('PATCH /api/barbers/me/service-area — barber can set polygon', { skip }, async () => {
  await resetDb()
  const barber  = await seedBarber()
  const app     = await getApp()
  const polygon = [
    { lat: 33.75, lng: -84.39 }, { lat: 33.76, lng: -84.39 },
    { lat: 33.76, lng: -84.38 }, { lat: 33.75, lng: -84.38 }, { lat: 33.75, lng: -84.39 },
  ]
  const r       = await request(app)
    .patch('/api/barbers/me/service-area')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({ polygon })
  assert.equal(r.status, 200, JSON.stringify(r.body))
})

/* ─── GET /api/barbers/me/payouts ────────────────────── */

test('GET /api/barbers/me/payouts — barber can list payouts', { skip }, async () => {
  await resetDb()
  const barber = await seedBarber()
  const app    = await getApp()
  const r      = await request(app)
    .get('/api/barbers/me/payouts')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
  assert.ok(r.status === 200 || r.status === 402, JSON.stringify(r.body)) // 402 if Stripe not set
})

/* ─── GET /api/barbers/:id/schedule — public ─────────── */

test('GET /api/barbers/:id/schedule — public, no auth required', { skip }, async () => {
  await resetDb()
  const barber = await seedBarber()
  const app    = await getApp()
  const r      = await request(app).get(`/api/barbers/${barber.id}/schedule`)
  assert.equal(r.status, 200)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
