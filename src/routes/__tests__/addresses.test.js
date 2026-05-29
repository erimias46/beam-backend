// Integration tests for /api/addresses — saved addresses (spec 0040).

import test from 'node:test'
import assert from 'node:assert/strict'
import { pointAppPoolAtTestDb, resetDb, seedUser, closeAll, testPool } from '../../__tests__/helpers/db.js'

pointAppPoolAtTestDb()
process.env.MASTER_OTP = '000000'

const { getApp, jwtFor } = await import('../../__tests__/helpers/app.js')
const request = (await import('supertest')).default
const dbOk = await testPool.query('SELECT 1').then(() => true).catch(() => false)
const skip  = !dbOk

const ADDR = { label: 'Home', address: '123 Main St, Atlanta, GA 30301', lat: 33.749, lng: -84.388 }

/* ─── GET /api/addresses ──────────────────────────────── */

test('GET /api/addresses — returns empty list initially', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app).get('/api/addresses').set('Authorization', `Bearer ${jwtFor(user)}`)
  assert.equal(r.status, 200)
  const list = r.body.addresses ?? r.body
  assert.ok(Array.isArray(list))
  assert.equal(list.length, 0)
})

test('GET /api/addresses — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal((await request(app).get('/api/addresses')).status, 401)
})

/* ─── POST /api/addresses ─────────────────────────────── */

test('POST /api/addresses — creates address', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .post('/api/addresses')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
    .send(ADDR)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const addr = r.body.address ?? r.body
  assert.equal(addr.label,   ADDR.label)
  assert.equal(addr.address, ADDR.address)
})

test('POST /api/addresses — missing address field returns 400', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const r    = await request(app)
    .post('/api/addresses')
    .set('Authorization', `Bearer ${jwtFor(user)}`)
    .send({ label: 'Home' })
  assert.ok(r.status >= 400)
})

test('POST /api/addresses — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal((await request(app).post('/api/addresses').send(ADDR)).status, 401)
})

/* ─── PATCH /api/addresses/:id ────────────────────────── */

test('PATCH /api/addresses/:id — updates label', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const cr   = await request(app).post('/api/addresses').set('Authorization', `Bearer ${jwtFor(user)}`).send(ADDR)
  const id   = (cr.body.address ?? cr.body).id
  const r    = await request(app)
    .patch(`/api/addresses/${id}`)
    .set('Authorization', `Bearer ${jwtFor(user)}`)
    .send({ label: 'Work' })
  assert.equal(r.status, 200)
  assert.equal((r.body.address ?? r.body).label, 'Work')
})

test('PATCH /api/addresses/:id — other user returns 403 or 404', { skip }, async () => {
  await resetDb()
  const u1  = await seedUser()
  const u2  = await seedUser()
  const app = await getApp()
  const cr  = await request(app).post('/api/addresses').set('Authorization', `Bearer ${jwtFor(u1)}`).send(ADDR)
  const id  = (cr.body.address ?? cr.body).id
  const r   = await request(app)
    .patch(`/api/addresses/${id}`)
    .set('Authorization', `Bearer ${jwtFor(u2)}`)
    .send({ label: 'Evil' })
  assert.ok(r.status === 403 || r.status === 404)
})

/* ─── DELETE /api/addresses/:id ───────────────────────── */

test('DELETE /api/addresses/:id — owner can delete', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  const cr   = await request(app).post('/api/addresses').set('Authorization', `Bearer ${jwtFor(user)}`).send(ADDR)
  const id   = (cr.body.address ?? cr.body).id
  const r    = await request(app).delete(`/api/addresses/${id}`).set('Authorization', `Bearer ${jwtFor(user)}`)
  assert.equal(r.status, 200)
  // Confirm gone
  const list = await request(app).get('/api/addresses').set('Authorization', `Bearer ${jwtFor(user)}`)
  const addresses = list.body.addresses ?? list.body
  assert.ok(!addresses.find(a => a.id === id))
})

test('DELETE /api/addresses/:id — other user returns 403 or 404', { skip }, async () => {
  await resetDb()
  const u1  = await seedUser()
  const u2  = await seedUser()
  const app = await getApp()
  const cr  = await request(app).post('/api/addresses').set('Authorization', `Bearer ${jwtFor(u1)}`).send(ADDR)
  const id  = (cr.body.address ?? cr.body).id
  const r   = await request(app).delete(`/api/addresses/${id}`).set('Authorization', `Bearer ${jwtFor(u2)}`)
  assert.ok(r.status === 403 || r.status === 404)
})

/* ─── Multiple addresses ──────────────────────────────── */

test('Can create multiple addresses and list them all', { skip }, async () => {
  await resetDb()
  const user = await seedUser()
  const app  = await getApp()
  await request(app).post('/api/addresses').set('Authorization', `Bearer ${jwtFor(user)}`).send({ ...ADDR, label: 'Home' })
  await request(app).post('/api/addresses').set('Authorization', `Bearer ${jwtFor(user)}`).send({ ...ADDR, label: 'Work', address: '456 Office Blvd' })
  const r    = await request(app).get('/api/addresses').set('Authorization', `Bearer ${jwtFor(user)}`)
  const list = r.body.addresses ?? r.body
  assert.equal(list.length, 2)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
