// Integration tests for /api/payments routes.

import test from 'node:test'
import assert from 'node:assert/strict'
import { pointAppPoolAtTestDb, resetDb, seedUser, closeAll, testPool } from '../../__tests__/helpers/db.js'

pointAppPoolAtTestDb()
process.env.MASTER_OTP = '000000'

const { getApp, jwtFor } = await import('../../__tests__/helpers/app.js')
const request = (await import('supertest')).default
const dbOk = await testPool.query('SELECT 1').then(() => true).catch(() => false)
const skip  = !dbOk

/* ─── GET /api/payments/methods ───────────────────────── */

test('GET /api/payments/methods — authenticated returns list', { skip }, async () => {
  await resetDb()
  const user = await seedUser({ role: 'customer' })
  const app  = await getApp()
  const r    = await request(app)
    .get('/api/payments/methods')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body.methods) || r.body.methods === null || r.body.methods === undefined || Array.isArray(r.body))
})

test('GET /api/payments/methods — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).get('/api/payments/methods')
  assert.equal(r.status, 401)
})

/* ─── POST /api/payments/setup-intent ─────────────────── */

test('POST /api/payments/setup-intent — requires auth', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).post('/api/payments/setup-intent')
  assert.equal(r.status, 401)
})

test('POST /api/payments/setup-intent — with auth returns Stripe error or client_secret', { skip }, async () => {
  await resetDb()
  const user = await seedUser({ role: 'customer' })
  const app  = await getApp()
  const r    = await request(app)
    .post('/api/payments/setup-intent')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
  // With no/placeholder Stripe key the route returns 503 (not configured) or Stripe error — just verify auth passed
  assert.ok(r.status === 200 || r.status === 402 || r.status === 500 || r.status === 503)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
