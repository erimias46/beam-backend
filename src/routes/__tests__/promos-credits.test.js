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

test('GET /api/credits/balance — authenticated returns balance object', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .get('/api/credits/balance')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
  assert.equal(r.status, 200)
  // balance_cents may be null or 0 for a new user
  assert.ok('balance_cents' in r.body, 'response should include balance_cents')
})

test('GET /api/credits/balance — new user balance is 0 or null', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .get('/api/credits/balance')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
  const bal = r.body.balance_cents
  assert.ok(bal === 0 || bal === null || bal === undefined, `expected 0/null, got ${bal}`)
})

test('GET /api/credits/balance — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal((await request(app).get('/api/credits/balance')).status, 401)
})

/* ─── GET /api/credits/history ────────────────────────── */

test('GET /api/credits/history — returns 200 with array', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .get('/api/credits/history')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
  assert.equal(r.status, 200)
  // Response is either array at root or { history: [...] }
  const list = r.body.credits ?? r.body.history ?? r.body
  assert.ok(Array.isArray(list) || list === null, `expected array, got ${typeof list}`)
})

/* ─── POST /api/promos/validate ───────────────────────── */

test('POST /api/promos/validate — non-existent code returns applies=false', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .post('/api/promos/validate')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
    .send({ code: 'DOESNOTEXIST', booking_total_cents: 5000 })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.applies, false)
  assert.ok(r.body.reason, 'should include a reason')
})

test('POST /api/promos/validate — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal(
    (await request(app).post('/api/promos/validate').send({ code: 'TEST', booking_total_cents: 5000 })).status,
    401
  )
})

/* ─── Admin: create promo (type:'percent') + validate ──── */

test('Admin creates percent-off promo, customer validates it', { skip }, async () => {
  await resetDb()
  const admin    = await seedUser({ role: 'admin' })
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()

  const code = 'TESTPCT10'
  const cr   = await request(app)
    .post('/api/admin/promos')
    .set('Authorization', `Bearer ${jwtFor(admin)}`)
    .send({
      code,
      type:          'percent',
      percent_off:   10,
      valid_from:    new Date(Date.now() - 60_000).toISOString(),
      redemptions_max: 100,
    })
  assert.ok(cr.status === 200 || cr.status === 201, `create promo: ${JSON.stringify(cr.body)}`)

  const vr = await request(app)
    .post('/api/promos/validate')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ code, booking_total_cents: 5000 })
  assert.equal(vr.status, 200, JSON.stringify(vr.body))
  assert.equal(vr.body.applies, true)
  assert.ok(vr.body.discount_cents > 0)
})

test('Admin grants credits, balance increases', { skip }, async () => {
  await resetDb()
  const admin    = await seedUser({ role: 'admin' })
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()

  const idempKey = `grant-${Date.now()}`
  const gr = await request(app)
    .post('/api/admin/credits/grant')
    .set('Authorization', `Bearer ${jwtFor(admin)}`)
    .set('Idempotency-Key', idempKey)
    .send({ user_id: customer.id, amount_cents: 1500, reason: 'test_grant' })
  assert.ok(gr.status === 200 || gr.status === 201, JSON.stringify(gr.body))

  const br = await request(app)
    .get('/api/credits/balance')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.ok((br.body.balance_cents ?? 0) >= 1500)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
