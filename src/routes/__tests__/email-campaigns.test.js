// Integration tests for email campaign unsubscribe + tracking (spec 0073).

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { pointAppPoolAtTestDb, resetDb, seedUser, closeAll, testPool } from '../../__tests__/helpers/db.js'

pointAppPoolAtTestDb()
process.env.MASTER_OTP = '000000'

const { getApp } = await import('../../__tests__/helpers/app.js')
const request    = (await import('supertest')).default
const dbOk = await testPool.query('SELECT 1').then(() => true).catch(() => false)
const skip  = !dbOk

/** Build an HMAC-signed token matching the same algo as the route. */
function buildToken(payload) {
  const secret = process.env.JWT_SECRET
  const body   = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac    = crypto.createHmac('sha256', secret).update(body).digest('base64url').slice(0, 32)
  return `${body}.${mac}`
}

/* ─── GET /api/unsubscribe ────────────────────────────────── */

test('GET /api/unsubscribe — valid token unsubscribes user', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()

  const token = buildToken({ uid: user.id, campaign: 'win_back' })
  const r     = await request(app).get(`/api/unsubscribe?token=${token}`)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(r.text.toLowerCase().includes('unsubscribed'))

  // Confirm email_notifications is now false
  const { rows } = await testPool.query(
    `SELECT email_notifications FROM users WHERE id = $1`, [user.id]
  )
  assert.equal(rows[0].email_notifications, false)
})

test('GET /api/unsubscribe — invalid/tampered token returns 400', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).get('/api/unsubscribe?token=invalid.token')
  assert.equal(r.status, 400)
})

test('GET /api/unsubscribe — missing token returns 400', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).get('/api/unsubscribe')
  assert.equal(r.status, 400)
})

/* ─── GET /api/unsubscribe/open (tracking pixel) ─────────── */

test('GET /api/unsubscribe/open — returns 1x1 gif', { skip }, async () => {
  await resetDb()
  const user  = await seedUser()
  const app   = await getApp()
  const token = buildToken({ uid: user.id, campaign: 'win_back' })
  const r     = await request(app).get(`/api/unsubscribe/open?token=${token}`)
  assert.equal(r.status, 200)
  assert.ok(r.headers['content-type'].includes('image/gif'))
})

test('GET /api/unsubscribe/open — returns gif even with invalid token', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).get('/api/unsubscribe/open?token=bad')
  assert.equal(r.status, 200)
  assert.ok(r.headers['content-type'].includes('image/gif'))
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
