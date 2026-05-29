// Integration tests for /api/auth/sessions (spec 0074).

import test from 'node:test'
import assert from 'node:assert/strict'
import { pointAppPoolAtTestDb, resetDb, seedUser, closeAll, testPool } from '../../__tests__/helpers/db.js'

pointAppPoolAtTestDb()
process.env.MASTER_OTP = '000000'

const { getApp, jwtFor } = await import('../../__tests__/helpers/app.js')
const request = (await import('supertest')).default
const dbOk = await testPool.query('SELECT 1').then(() => true).catch(() => false)
const skip  = !dbOk

/* ─── GET /api/auth/sessions ──────────────────────────── */

test('GET /api/auth/sessions — returns list', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .get('/api/auth/sessions')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
  assert.equal(r.status, 200)
  const list = r.body.sessions ?? r.body
  assert.ok(Array.isArray(list))
})

test('GET /api/auth/sessions — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal((await request(app).get('/api/auth/sessions')).status, 401)
})

/* ─── Session created on login ────────────────────────── */

test('Verify-otp creates a session row', { skip }, async () => {
  await resetDb()
  const app   = await getApp()
  const email = 'session.test@beam0.example'

  // Login via OTP
  await request(app).post('/api/auth/send-otp').send({ email })
  const auth = await request(app).post('/api/auth/verify-otp').send({ email, code: '000000', role: 'customer' })
  assert.equal(auth.status, 200)
  const token = auth.body.token

  // Sessions list should have one entry
  const r    = await request(app).get('/api/auth/sessions').set('Authorization', `Bearer ${token}`)
  const list = r.body.sessions ?? r.body
  assert.ok(list.length >= 1, 'session should be created on login')
})

/* ─── DELETE /api/auth/sessions/:id ──────────────────── */

test('DELETE /api/auth/sessions/:id — revokes a session', { skip }, async () => {
  await resetDb()
  const app   = await getApp()
  const email = 'revoke.test@beam0.example'

  await request(app).post('/api/auth/send-otp').send({ email })
  const auth  = await request(app).post('/api/auth/verify-otp').send({ email, code: '000000', role: 'customer' })
  const token = auth.body.token

  const sessions   = await request(app).get('/api/auth/sessions').set('Authorization', `Bearer ${token}`)
  const sessionList = sessions.body.sessions ?? sessions.body
  assert.ok(sessionList.length >= 1)

  const id = sessionList[0].id
  const r  = await request(app)
    .delete(`/api/auth/sessions/${id}`)
    .set('Authorization', `Bearer ${token}`)
  assert.ok(r.status === 200 || r.status === 204, JSON.stringify(r.body))
})

test('DELETE /api/auth/sessions/:id — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal((await request(app).delete('/api/auth/sessions/some-id')).status, 401)
})

/* ─── DELETE /api/auth/sessions — revoke all ──────────── */

test('DELETE /api/auth/sessions — revokes all sessions', { skip }, async () => {
  await resetDb()
  const app   = await getApp()
  const email = 'revoke.all@beam0.example'

  await request(app).post('/api/auth/send-otp').send({ email })
  const auth  = await request(app).post('/api/auth/verify-otp').send({ email, code: '000000', role: 'customer' })
  const token = auth.body.token

  const r = await request(app)
    .delete('/api/auth/sessions')
    .set('Authorization', `Bearer ${token}`)
  assert.ok(r.status === 200 || r.status === 204, JSON.stringify(r.body))
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
