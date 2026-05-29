// Integration tests for /api/blocks and /api/reports (spec 0022).

import test from 'node:test'
import assert from 'node:assert/strict'
import { pointAppPoolAtTestDb, resetDb, seedUser, closeAll, testPool } from '../../__tests__/helpers/db.js'

pointAppPoolAtTestDb()
process.env.MASTER_OTP = '000000'

const { getApp, jwtFor } = await import('../../__tests__/helpers/app.js')
const request = (await import('supertest')).default
const dbOk = await testPool.query('SELECT 1').then(() => true).catch(() => false)
const skip  = !dbOk

/* ─── GET /api/blocks ─────────────────────────────────── */

test('GET /api/blocks — returns empty list initially', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app).get('/api/blocks').set('Authorization', `Bearer ${jwtFor(user)}`)
  assert.equal(r.status, 200)
  const list = r.body.blocks ?? r.body
  assert.ok(Array.isArray(list))
  assert.equal(list.length, 0)
})

test('GET /api/blocks — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal((await request(app).get('/api/blocks')).status, 401)
})

/* ─── POST /api/blocks — block a user ─────────────────── */

test('POST /api/blocks — user can block another user', { skip }, async () => {
  await resetDb()
  const u1  = await seedUser({ role: 'customer' })
  const u2  = await seedUser({ role: 'barber'   })
  const app = await getApp()
  const r   = await request(app)
    .post('/api/blocks')
    .set('Authorization', `Bearer ${jwtFor(u1)}`)
    .send({ blocked_id: u2.id })
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body))
})

test('POST /api/blocks — cannot block yourself', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .post('/api/blocks')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
    .send({ blocked_id: user.id })
  assert.ok(r.status >= 400)
})

test('POST /api/blocks — after block, blocked user appears in list', { skip }, async () => {
  await resetDb()
  const u1  = await seedUser({ role: 'customer' })
  const u2  = await seedUser({ role: 'barber'   })
  const app = await getApp()
  await request(app).post('/api/blocks').set('Authorization', `Bearer ${jwtFor(u1)}`).send({ blocked_id: u2.id })
  const r    = await request(app).get('/api/blocks').set('Authorization', `Bearer ${jwtFor(u1)}`)
  const list = r.body.blocks ?? r.body
  assert.ok(list.some(b => b.blocked_id === u2.id || b.id === u2.id))
})

test('POST /api/blocks — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal((await request(app).post('/api/blocks').send({ blocked_id: 'x' })).status, 401)
})

/* ─── DELETE /api/blocks/:id — unblock ─────────────────── */

test('DELETE /api/blocks/:id — user can unblock', { skip }, async () => {
  await resetDb()
  const u1  = await seedUser({ role: 'customer' })
  const u2  = await seedUser({ role: 'barber'   })
  const app = await getApp()
  await request(app).post('/api/blocks').set('Authorization', `Bearer ${jwtFor(u1)}`).send({ blocked_id: u2.id })
  const r   = await request(app)
    .delete(`/api/blocks/${u2.id}`)
    .set('Authorization', `Bearer ${jwtFor(u1)}`)
  assert.ok(r.status === 200 || r.status === 204, JSON.stringify(r.body))
  // Verify gone
  const list = await request(app).get('/api/blocks').set('Authorization', `Bearer ${jwtFor(u1)}`)
  const blocks = list.body.blocks ?? list.body
  assert.ok(!blocks.some(b => b.blocked_id === u2.id || b.id === u2.id))
})

/* ─── POST /api/reports ───────────────────────────────── */

test('POST /api/reports — user can report another user', { skip }, async () => {
  await resetDb()
  const u1  = await seedUser({ role: 'customer' })
  const u2  = await seedUser({ role: 'barber'   })
  const app = await getApp()
  const r   = await request(app)
    .post('/api/reports')
    .set('Authorization', `Bearer ${jwtFor(u1)}`)
    .send({ reported_id: u2.id, reason: 'inappropriate_behavior', notes: 'Test report note here.' })
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body))
})

test('POST /api/reports — cannot report yourself', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .post('/api/reports')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
    .send({ reported_id: user.id, reason: 'spam' })
  assert.ok(r.status >= 400)
})

test('POST /api/reports — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal((await request(app).post('/api/reports').send({ reported_id: 'x' })).status, 401)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
