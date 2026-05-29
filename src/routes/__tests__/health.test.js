// Health endpoint tests (spec 0003).

import test from 'node:test'
import assert from 'node:assert/strict'
import { pointAppPoolAtTestDb, closeAll, testPool } from '../../__tests__/helpers/db.js'

pointAppPoolAtTestDb()

const { getApp } = await import('../../__tests__/helpers/app.js')
const request = (await import('supertest')).default
const dbOk = await testPool.query('SELECT 1').then(() => true).catch(() => false)
const skip  = !dbOk

test('GET /health — returns ok:true', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).get('/health')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.ok(typeof r.body.ts === 'number')
})

test('GET /health — no auth required', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).get('/health')
  assert.equal(r.status, 200)
})

test('GET /health/ready — returns DB and Redis status', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).get('/health/ready')
  assert.ok(r.status === 200 || r.status === 503)
  assert.ok('db' in r.body || 'ok' in r.body)
})

test('GET /health — includes uptime_s field', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).get('/health')
  assert.ok(typeof r.body.uptime_s === 'number')
  assert.ok(r.body.uptime_s >= 0)
})

test('Unknown route returns 404', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).get('/api/this-does-not-exist')
  assert.equal(r.status, 404)
})

test('GET /api/config — returns public config', { skip }, async () => {
  const app = await getApp()
  const r   = await request(app).get('/api/config')
  assert.equal(r.status, 200)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
