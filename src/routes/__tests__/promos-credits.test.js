// Integration tests for /api/promos, /api/credits, /api/users/me/referral-code (spec 0070).

import test from 'node:test'
import assert from 'node:assert/strict'
import { pointAppPoolAtTestDb, resetDb, seedUser, closeAll, testPool } from '../../__tests__/helpers/db.js'

pointAppPoolAtTestDb()
process.env.MASTER_OTP = '000000'

const { getApp, jwtFor } = await import('../../__tests__/helpers/app.js')
const request = (await import('supertest')).default
const dbOk = await testPool.query('SELECT 1').then(() => true).catch(() => false)
const skip  = !dbOk

/* ─── GET /api/users/me/referral-code ─────────────────── */

test('GET /api/users/me/referral-code — returns code for user', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .get('/api/users/me/referral-code')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(r.body.code, 'should return a referral code')
})

test('GET /api/users/me/referral-code — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal((await request(app).get('/api/users/me/referral-code')).status, 401)
})

/* ─── GET /api/credits/balance ────────────────────────── */

test('GET /api/credits/balance — returns balance', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .get('/api/credits/balance')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
  assert.equal(r.status, 200)
  assert.ok(typeof r.body.balance_cents === 'number')
})

test('GET /api/credits/balance — new user has zero balance', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .get('/api/credits/balance')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
  assert.equal(r.body.balance_cents, 0)
})

test('GET /api/credits/balance — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal((await request(app).get('/api/credits/balance')).status, 401)
})

/* ─── GET /api/credits/history ────────────────────────── */

test('GET /api/credits/history — returns list', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .get('/api/credits/history')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
  assert.equal(r.status, 200)
  const list = r.body.history ?? r.body
  assert.ok(Array.isArray(list))
})

/* ─── POST /api/promos/validate ───────────────────────── */

test('POST /api/promos/validate — non-existent code returns applies=false', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .post('/api/promos/validate')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
    .send({ code: 'DOESNOTEXIST', price_cents: 5000 })
  assert.equal(r.status, 200)
  assert.equal(r.body.applies, false)
  assert.equal(r.body.reason, 'not_found')
})

test('POST /api/promos/validate — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal(
    (await request(app).post('/api/promos/validate').send({ code: 'TEST', price_cents: 5000 })).status,
    401
  )
})

/* ─── Admin: create promo + validate it ───────────────── */

test('Admin creates promo, customer can validate it', { skip }, async () => {
  await resetDb()
  const admin    = await seedUser({ role: 'admin' })
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()

  // Create promo
  const code = 'TESTCODE10'
  const cr   = await request(app)
    .post('/api/admin/promos')
    .set('Authorization', `Bearer ${jwtFor(admin)}`)
    .send({ code, discount_bps: 1000, max_redemptions: 100, valid_from: new Date(Date.now() - 60_000).toISOString() })
  assert.ok(cr.status === 200 || cr.status === 201, `create promo: ${JSON.stringify(cr.body)}`)

  // Validate promo as customer
  const vr = await request(app)
    .post('/api/promos/validate')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ code, price_cents: 5000 })
  assert.equal(vr.status, 200, JSON.stringify(vr.body))
  assert.equal(vr.body.applies, true)
  assert.ok(vr.body.discount_cents > 0)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
