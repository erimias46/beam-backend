// Integration tests for /api/devices (Web Push subscriptions, spec 0007).

import test from 'node:test'
import assert from 'node:assert/strict'
import { pointAppPoolAtTestDb, resetDb, seedUser, closeAll, testPool } from '../../__tests__/helpers/db.js'

pointAppPoolAtTestDb()
process.env.MASTER_OTP = '000000'

const { getApp, jwtFor } = await import('../../__tests__/helpers/app.js')
const request = (await import('supertest')).default
const dbOk = await testPool.query('SELECT 1').then(() => true).catch(() => false)
const skip  = !dbOk

const VALID_SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint-unique-12345',
  keys: {
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlqHgx9f48EFn8HvbKBf',
    auth:   'tBHItJI5svbpez7KI4CCXg',
  },
  expirationTime: null,
}

/* ─── POST /api/devices/push-subscribe ────────────────────── */

test('POST /api/devices/push-subscribe — requires auth', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).post('/api/devices/push-subscribe').send(VALID_SUB)
  assert.equal(r.status, 401)
})

test('POST /api/devices/push-subscribe — saves subscription', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .post('/api/devices/push-subscribe')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
    .send(VALID_SUB)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(r.body.ok)
})

test('POST /api/devices/push-subscribe — upserts on duplicate endpoint', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  // First subscribe
  await request(app).post('/api/devices/push-subscribe').set('Authorization', `Bearer ${jwtFor(user)}`).send(VALID_SUB)
  // Second subscribe (same endpoint) should not error
  const r = await request(app)
    .post('/api/devices/push-subscribe')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
    .send(VALID_SUB)
  assert.equal(r.status, 200)
})

test('POST /api/devices/push-subscribe — invalid payload returns 400', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .post('/api/devices/push-subscribe')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
    .send({ endpoint: 'not-a-url' })
  assert.equal(r.status, 400)
})

/* ─── DELETE /api/devices/push-subscribe ─────────────────── */

test('DELETE /api/devices/push-subscribe — requires auth', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).delete('/api/devices/push-subscribe').send({ endpoint: VALID_SUB.endpoint })
  assert.equal(r.status, 401)
})

test('DELETE /api/devices/push-subscribe — removes subscription', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  // Subscribe first
  await request(app).post('/api/devices/push-subscribe').set('Authorization', `Bearer ${jwtFor(user)}`).send(VALID_SUB)
  // Unsubscribe
  const r = await request(app)
    .delete('/api/devices/push-subscribe')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
    .send({ endpoint: VALID_SUB.endpoint })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(r.body.ok)
  // Confirm it's gone from DB
  const { rows } = await testPool.query(
    `SELECT 1 FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
    [user.id, VALID_SUB.endpoint]
  )
  assert.equal(rows.length, 0, 'subscription should be deleted')
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
