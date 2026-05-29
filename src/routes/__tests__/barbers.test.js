// Integration tests for /api/barbers routes.

import test from 'node:test'
import assert from 'node:assert/strict'
import { pointAppPoolAtTestDb, resetDb, seedUser, closeAll, testPool } from '../../__tests__/helpers/db.js'

pointAppPoolAtTestDb()
process.env.MASTER_OTP = '000000'

const { getApp, jwtFor } = await import('../../__tests__/helpers/app.js')
const request = (await import('supertest')).default

const dbOk = await testPool.query('SELECT 1').then(() => true).catch(() => false)
const skip  = !dbOk

async function seedBarberWithProfile(opts = {}) {
  const barber = await seedUser({ role: 'barber', ...opts })
  await testPool.query(
    `INSERT INTO barber_profiles (user_id, is_available, services, bio, years_experience)
     VALUES ($1, true, $2::jsonb, $3, $4)`,
    [
      barber.id,
      JSON.stringify([{ name: 'Fade', price_cents: 3500, duration_min: 45 }]),
      'Test bio',
      5,
    ]
  )
  return barber
}

/* ─── GET /api/barbers ────────────────────────────────── */

test('GET /api/barbers — returns available barbers', { skip }, async () => {
  await resetDb()
  await seedBarberWithProfile()
  const app = await getApp()
  const r   = await request(app).get('/api/barbers')
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body.barbers ?? r.body))
})

test('GET /api/barbers — excludes unavailable barbers', { skip }, async () => {
  await resetDb()
  const b1 = await seedUser({ role: 'barber' })
  await testPool.query(
    `INSERT INTO barber_profiles (user_id, is_available, services) VALUES ($1, false, '[]'::jsonb)`,
    [b1.id]
  )
  await seedBarberWithProfile()
  const app  = await getApp()
  const r    = await request(app).get('/api/barbers')
  const list = r.body.barbers ?? r.body
  assert.ok(list.every(b => b.is_available !== false), 'unavailable barber should not appear')
})

test('GET /api/barbers — filter by min_rating', { skip }, async () => {
  await resetDb()
  const app = await getApp()
  const r   = await request(app).get('/api/barbers?min_rating=4.5')
  assert.equal(r.status, 200)
})

test('GET /api/barbers — filter by max_price_cents', { skip }, async () => {
  await resetDb()
  const app = await getApp()
  const r   = await request(app).get('/api/barbers?max_price_cents=5000')
  assert.equal(r.status, 200)
})

/* ─── GET /api/barbers/:id ────────────────────────────── */

test('GET /api/barbers/:id — returns barber profile', { skip }, async () => {
  await resetDb()
  const barber = await seedBarberWithProfile()
  const app    = await getApp()
  const r      = await request(app).get(`/api/barbers/${barber.id}`)
  assert.equal(r.status, 200)
  assert.equal(r.body.barber?.id ?? r.body.id, barber.id)
})

test('GET /api/barbers/:id — non-existent returns 404', { skip }, async () => {
  await resetDb()
  const app = await getApp()
  const r   = await request(app).get('/api/barbers/00000000-0000-0000-0000-000000000000')
  assert.equal(r.status, 404)
})

/* ─── POST /api/barbers/profile ───────────────────────── */

test('POST /api/barbers/profile — barber can update profile', { skip }, async () => {
  await resetDb()
  const barber = await seedUser({ role: 'barber' })
  const app    = await getApp()
  const r      = await request(app)
    .post('/api/barbers/profile')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({
      bio:              'Great barber',
      years_experience: 7,
      services:         [{ name: 'Fade', price_cents: 4000, duration_min: 45 }],
    })
  assert.equal(r.status, 200, JSON.stringify(r.body))
})

test('POST /api/barbers/profile — customer returns 403', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()
  const r        = await request(app)
    .post('/api/barbers/profile')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ bio: 'hi' })
  assert.equal(r.status, 403)
})

test('POST /api/barbers/profile — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).post('/api/barbers/profile').send({ bio: 'hi' })
  assert.equal(r.status, 401)
})

/* ─── PATCH /api/barbers/availability ─────────────────── */

test('PATCH /api/barbers/availability — barber can toggle', { skip }, async () => {
  await resetDb()
  const barber = await seedBarberWithProfile()
  const app    = await getApp()
  const r      = await request(app)
    .patch('/api/barbers/availability')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({ is_available: false })
  assert.equal(r.status, 200)
})

test('PATCH /api/barbers/availability — customer returns 403', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()
  const r        = await request(app)
    .patch('/api/barbers/availability')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ is_available: false })
  assert.equal(r.status, 403)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
