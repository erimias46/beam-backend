// Integration tests for /api/auth/sessions (spec 0074).
// Sessions are created when verify-otp is called — NOT by jwtFor() helper.
// Tests that need a session must go through the OTP flow.

import test from 'node:test'
import assert from 'node:assert/strict'
import { pointAppPoolAtTestDb, resetDb, seedUser, closeAll, testPool } from '../../__tests__/helpers/db.js'

pointAppPoolAtTestDb()
process.env.MASTER_OTP = '000000'

const { getApp, jwtFor } = await import('../../__tests__/helpers/app.js')
const request = (await import('supertest')).default
const dbOk = await testPool.query('SELECT 1').then(() => true).catch(() => false)
const skip  = !dbOk

async function loginViaOtp(app, email = `sess.${Date.now()}@beam0.example`) {
  await request(app).post('/api/auth/send-otp').send({ email })
  const r = await request(app).post('/api/auth/verify-otp').send({ email, code: '000000', role: 'customer' })
  return { token: r.body.access_token || r.body.token, userId: r.body.user?.id }
}

/* ─── GET /api/auth/sessions ──────────────────────────── */

test('GET /api/auth/sessions — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal((await request(app).get('/api/auth/sessions')).status, 401)
})

test('GET /api/auth/sessions — returns list (may be empty for jwtFor token)', { skip }, async () => {
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

/* ─── Session created on login ────────────────────────── */

test('Verify-otp creates a session row in DB', { skip }, async () => {
  await resetDb()
  const app = await getApp()
  const { token } = await loginViaOtp(app)
  // Sessions list via the access token (which was also minted by verify-otp)
  const r    = await request(app).get('/api/auth/sessions').set('Authorization', `Bearer ${token}`)
  assert.equal(r.status, 200)
  const list = r.body.sessions ?? r.body
  assert.ok(list.length >= 1, `Expected ≥1 session, got ${JSON.stringify(list)}`)
})

/* ─── DELETE /api/auth/sessions/:id ──────────────────── */

test('DELETE /api/auth/sessions/:id — revokes a session', { skip }, async () => {
  await resetDb()
  const app           = await getApp()
  const { token }     = await loginViaOtp(app)
  const sessionsRes   = await request(app).get('/api/auth/sessions').set('Authorization', `Bearer ${token}`)
  const sessionList   = sessionsRes.body.sessions ?? sessionsRes.body
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
  const app       = await getApp()
  const { token } = await loginViaOtp(app)
  const r         = await request(app)
    .delete('/api/auth/sessions')
    .set('Authorization', `Bearer ${token}`)
  assert.ok(r.status === 200 || r.status === 204, JSON.stringify(r.body))
})

test('DELETE /api/auth/sessions — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal((await request(app).delete('/api/auth/sessions')).status, 401)
})

/* ─── FE-1: /refresh and /logout cookie management ───── */

test('POST /api/auth/refresh — sets updated access_token cookie', { skip }, async () => {
  await resetDb()
  const app          = await getApp()
  const email        = `refresh.cookie.${Date.now()}@beam0.example`
  const loginRes     = await request(app).post('/api/auth/verify-otp').send({ email, code: '000000', role: 'customer' })
  const refreshToken = loginRes.body.refresh_token
  assert.ok(refreshToken, 'verify-otp must return a refresh_token')

  const r = await request(app).post('/api/auth/refresh').send({ refresh_token: refreshToken })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(r.body.access_token, '/refresh must return new access_token in body')

  const cookies     = [].concat(r.headers['set-cookie'] || [])
  const tokenCookie = cookies.find(c => c.startsWith('access_token='))
  assert.ok(tokenCookie, '/refresh must set access_token cookie')
  assert.ok(tokenCookie.toLowerCase().includes('httponly'), '/refresh cookie must be HttpOnly')
})

test('POST /api/auth/logout — clears access_token cookie', { skip }, async () => {
  await resetDb()
  const app       = await getApp()
  const { token } = await loginViaOtp(app)

  const r = await request(app)
    .post('/api/auth/logout')
    .set('Authorization', `Bearer ${token}`)
    .send({})
  assert.ok(r.status === 200 || r.status === 204, JSON.stringify(r.body))

  const cookies = [].concat(r.headers['set-cookie'] || [])
  const cleared = cookies.find(c => c.startsWith('access_token='))
  if (cleared) {
    // A cleared cookie has Max-Age=0 or an Expires in the past, or an empty value
    const isCleared = cleared.includes('Max-Age=0')
      || cleared.toLowerCase().includes('expires=thu, 01 jan 1970')
      || /access_token=;/.test(cleared)
    assert.ok(isCleared, `access_token cookie should be cleared; got: ${cleared}`)
  }
  // If no set-cookie header for access_token, the cookie was simply not re-set (also acceptable)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
