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

  const idempKey = `grant-test-existing-${Date.now()}`
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

/* ─── DB-2: applyCredit advisory lock tests ─────────── */

test('DB-2: applyCredit — sequential grants accumulate balance correctly', { skip }, async () => {
  await resetDb()
  const admin    = await seedUser({ role: 'admin' })
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()
  const now      = Date.now()

  for (const [i, amount] of [[1, 500], [2, 750], [3, 250]]) {
    const r = await request(app)
      .post('/api/admin/credits/grant')
      .set('Authorization', `Bearer ${jwtFor(admin)}`)
      .set('Idempotency-Key', `seq-credit-grant-${now}-${i}`)
      .send({ user_id: customer.id, amount_cents: amount, notes: `seq-${now}-${i}` })
    assert.ok(r.status === 200 || r.status === 201, `grant ${i} failed: ${JSON.stringify(r.body)}`)
  }

  const bal = await request(app)
    .get('/api/credits/balance')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.equal(bal.body.balance_cents, 1500, `expected 1500 accumulated, got ${bal.body.balance_cents}`)
})

test('DB-2: applyCredit — same source+ref is idempotent (ON CONFLICT DO NOTHING)', { skip }, async () => {
  // applyCredit uses ON CONFLICT (user_id, source, source_ref) DO NOTHING.
  // Two admin grants with identical (admin_id, notes) → same sourceRef → only one row inserted.
  await resetDb()
  const admin    = await seedUser({ role: 'admin' })
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()
  const now      = Date.now()

  // Two requests with DIFFERENT idempotency keys but the same notes (→ same sourceRef)
  const body = { user_id: customer.id, amount_cents: 1000, notes: `dedup-test-${now}` }
  const r1 = await request(app)
    .post('/api/admin/credits/grant')
    .set('Authorization', `Bearer ${jwtFor(admin)}`)
    .set('Idempotency-Key', `dedup-credit-a-${now}`)
    .send(body)
  const r2 = await request(app)
    .post('/api/admin/credits/grant')
    .set('Authorization', `Bearer ${jwtFor(admin)}`)
    .set('Idempotency-Key', `dedup-credit-b-${now}`)
    .send(body)
  assert.ok(r1.status === 200 || r1.status === 201, `first grant: ${JSON.stringify(r1.body)}`)
  assert.ok(r2.status === 200 || r2.status === 201, `second grant: ${JSON.stringify(r2.body)}`)

  const bal = await request(app)
    .get('/api/credits/balance')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  // Balance must be 1000, not 2000 — second insert hit ON CONFLICT DO NOTHING
  assert.equal(bal.body.balance_cents, 1000, `idempotency broken: got ${bal.body.balance_cents} instead of 1000`)
})

test('DB-2: applyCredit — parallel grants for same user produce correct total', { skip }, async () => {
  // Advisory lock serialises concurrent applyCredit calls per user,
  // so each reads a consistent prior balance. All grants must land.
  await resetDb()
  const admin    = await seedUser({ role: 'admin' })
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()
  const now      = Date.now()

  const amounts = [300, 700, 1000, 200, 800]  // total: 3000
  await Promise.all(amounts.map((amount, i) =>
    request(app)
      .post('/api/admin/credits/grant')
      .set('Authorization', `Bearer ${jwtFor(admin)}`)
      .set('Idempotency-Key', `parallel-credit-grant-${now}-${i}`)
      .send({ user_id: customer.id, amount_cents: amount, notes: `par-${now}-${i}` })
  ))

  const bal = await request(app)
    .get('/api/credits/balance')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  const total = amounts.reduce((s, a) => s + a, 0)
  assert.equal(bal.body.balance_cents, total,
    `parallel grants: expected ${total}, got ${bal.body.balance_cents} (advisory lock may not be serialising correctly)`)
})

test('DB-2: applyCredit — grants to different users do not interfere', { skip }, async () => {
  await resetDb()
  const admin = await seedUser({ role: 'admin' })
  const userA = await seedUser({ role: 'customer' })
  const userB = await seedUser({ role: 'customer' })
  const app   = await getApp()
  const now   = Date.now()

  await Promise.all([
    request(app).post('/api/admin/credits/grant')
      .set('Authorization', `Bearer ${jwtFor(admin)}`)
      .set('Idempotency-Key', `isolation-credit-a-${now}`)
      .send({ user_id: userA.id, amount_cents: 600, notes: `iso-${now}-a` }),
    request(app).post('/api/admin/credits/grant')
      .set('Authorization', `Bearer ${jwtFor(admin)}`)
      .set('Idempotency-Key', `isolation-credit-b-${now}`)
      .send({ user_id: userB.id, amount_cents: 400, notes: `iso-${now}-b` }),
  ])

  const [balA, balB] = await Promise.all([
    request(app).get('/api/credits/balance').set('Authorization', `Bearer ${jwtFor(userA)}`),
    request(app).get('/api/credits/balance').set('Authorization', `Bearer ${jwtFor(userB)}`),
  ])
  assert.equal(balA.body.balance_cents, 600, `userA balance wrong: ${balA.body.balance_cents}`)
  assert.equal(balB.body.balance_cents, 400, `userB balance wrong: ${balB.body.balance_cents}`)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
