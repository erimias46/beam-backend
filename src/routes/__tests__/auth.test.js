// Integration tests for /api/auth routes.
// Requires a running Postgres at TEST_DATABASE_URL.
// MASTER_OTP=000000 is used to bypass Redis OTP storage.

import test from 'node:test'
import assert from 'node:assert/strict'
import { pointAppPoolAtTestDb, resetDb, seedUser, closeAll, testPool } from '../../__tests__/helpers/db.js'

pointAppPoolAtTestDb()
process.env.MASTER_OTP = '000000'
process.env.SMTP_HOST  = ''  // disable real email in tests

const { getApp, jwtFor } = await import('../../__tests__/helpers/app.js')
const request = (await import('supertest')).default

const dbOk = await testPool.query('SELECT 1').then(() => true).catch(() => false)
const skip  = !dbOk

/* ─── /api/auth/send-otp ──────────────────────────────── */

test('POST /api/auth/send-otp — valid email returns ok', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).post('/api/auth/send-otp').send({ email: 'test@beam0.example' })
  assert.equal(r.status, 200)
  assert.ok(r.body.ok)
})

test('POST /api/auth/send-otp — invalid email returns 400', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).post('/api/auth/send-otp').send({ email: 'not-an-email' })
  assert.equal(r.status, 400)
})

test('POST /api/auth/send-otp — missing email returns 400', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).post('/api/auth/send-otp').send({})
  assert.equal(r.status, 400)
})

/* ─── /api/auth/verify-otp ───────────────────────────── */

test('POST /api/auth/verify-otp — MASTER_OTP creates/returns user', { skip }, async () => {
  await resetDb()
  const app = await getApp()
  const r = await request(app).post('/api/auth/verify-otp').send({
    email: 'newuser@beam0.example',
    code:  '000000',
    role:  'customer',
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(r.body.token)
  assert.equal(r.body.user.email, 'newuser@beam0.example')
  assert.equal(r.body.user.role,  'customer')
})

test('POST /api/auth/verify-otp — barber role creates barber_profile row', { skip }, async () => {
  await resetDb()
  const app = await getApp()
  await request(app).post('/api/auth/verify-otp').send({
    email: 'barber@beam0.example',
    code:  '000000',
    role:  'barber',
  })
  const { rows } = await testPool.query(
    `SELECT bp.user_id FROM barber_profiles bp JOIN users u ON u.id = bp.user_id WHERE u.email = $1`,
    ['barber@beam0.example']
  )
  assert.equal(rows.length, 1, 'barber_profile row should be created on barber signup')
})

test('POST /api/auth/verify-otp — wrong code returns 401', { skip }, async () => {
  await resetDb()
  const app = await getApp()
  // First ensure user exists so we're testing code mismatch, not signup gate
  await request(app).post('/api/auth/verify-otp').send({ email: 'x@beam0.example', code: '000000', role: 'customer' })
  // Now try with bad code
  const r = await request(app).post('/api/auth/verify-otp').send({
    email: 'x@beam0.example',
    code:  '999999',
    role:  'customer',
  })
  // MASTER_OTP=000000, so 999999 is wrong
  assert.equal(r.status, 401)
})

test('POST /api/auth/verify-otp — suspended user returns 403', { skip }, async () => {
  await resetDb()
  const user = await seedUser({ role: 'customer', email: 'suspended@beam0.example' })
  await testPool.query('UPDATE users SET is_suspended = true WHERE id = $1', [user.id])
  const app = await getApp()
  const r   = await request(app).post('/api/auth/verify-otp').send({
    email: 'suspended@beam0.example',
    code:  '000000',
  })
  assert.equal(r.status, 403)
})

/* ─── /api/auth/me ────────────────────────────────────── */

test('GET /api/auth/me — valid token returns user', { skip }, async () => {
  await resetDb()
  const user = await seedUser({ role: 'customer' })
  const app  = await getApp()
  const r    = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${jwtFor(user)}`)
  assert.equal(r.status, 200)
  assert.equal(r.body.user.id,   user.id)
  assert.equal(r.body.user.role, 'customer')
})

test('GET /api/auth/me — no token returns 401', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).get('/api/auth/me')
  assert.equal(r.status, 401)
})

test('GET /api/auth/me — invalid token returns 401', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).get('/api/auth/me').set('Authorization', 'Bearer garbage.token.here')
  assert.equal(r.status, 401)
})

/* ─── /api/auth/profile ───────────────────────────────── */

test('PATCH /api/auth/profile — updates name', { skip }, async () => {
  await resetDb()
  const user = await seedUser({ role: 'customer', name: 'Old Name' })
  const app  = await getApp()
  const r    = await request(app)
    .patch('/api/auth/profile')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
    .send({ name: 'New Name' })
  assert.equal(r.status, 200)
  assert.equal(r.body.user.name, 'New Name')
})

test('PATCH /api/auth/profile — empty name returns 400', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .patch('/api/auth/profile')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
    .send({ name: '' })
  assert.equal(r.status, 400)
})

test('PATCH /api/auth/profile — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).patch('/api/auth/profile').send({ name: 'Test' })
  assert.equal(r.status, 401)
})

/* ─── /api/auth/notifications ─────────────────────────── */

test('PATCH /api/auth/notifications — toggles pref', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .patch('/api/auth/notifications')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
    .send({ email_notifications: false })
  assert.equal(r.status, 200)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
