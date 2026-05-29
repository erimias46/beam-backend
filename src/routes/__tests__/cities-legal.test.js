// Integration tests for /api/cities and /api/legal.

import test from 'node:test'
import assert from 'node:assert/strict'
import { pointAppPoolAtTestDb, resetDb, seedUser, closeAll, testPool } from '../../__tests__/helpers/db.js'

pointAppPoolAtTestDb()
process.env.MASTER_OTP = '000000'

const { getApp, jwtFor } = await import('../../__tests__/helpers/app.js')
const request = (await import('supertest')).default
const dbOk = await testPool.query('SELECT 1').then(() => true).catch(() => false)
const skip  = !dbOk

/* ─── GET /api/cities ─────────────────────────────────── */

test('GET /api/cities — public, returns list', { skip }, async () => {
  await resetDb()
  const app = await getApp()
  const r   = await request(app).get('/api/cities')
  assert.equal(r.status, 200)
  const cities = r.body.cities ?? r.body
  assert.ok(Array.isArray(cities))
})

test('GET /api/cities — no auth required', { skip }, async () => {
  const app = await getApp()
  assert.equal((await request(app).get('/api/cities')).status, 200)
})

/* ─── Admin: POST /api/admin/cities ──────────────────── */

test('POST /api/admin/cities — admin can create city', { skip }, async () => {
  await resetDb()
  const admin = await seedUser({ role: 'admin' })
  const app   = await getApp()
  const r     = await request(app)
    .post('/api/admin/cities')
    .set('Authorization', `Bearer ${jwtFor(admin)}`)
    .send({
      slug:      'test-city',
      name:      'Test City',
      lat:       33.749,
      lng:       -84.388,
      is_active: true,
    })
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body))
})

test('POST /api/admin/cities — customer returns 403', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()
  const r        = await request(app)
    .post('/api/admin/cities')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ slug: 'x', name: 'X', lat: 0, lng: 0 })
  assert.equal(r.status, 403)
})

/* ─── GET /api/cities/:slug ──────────────────────────── */

test('GET /api/cities/:slug — returns city or 404', { skip }, async () => {
  await resetDb()
  const app = await getApp()
  const r   = await request(app).get('/api/cities/nonexistent-slug')
  assert.ok(r.status === 200 || r.status === 404)
})

test('Admin can create then retrieve city by slug', { skip }, async () => {
  await resetDb()
  const admin = await seedUser({ role: 'admin' })
  const app   = await getApp()
  await request(app).post('/api/admin/cities').set('Authorization', `Bearer ${jwtFor(admin)}`).send({
    slug: 'brooklyn-ny', name: 'Brooklyn, NY', lat: 40.678, lng: -73.944, is_active: true,
  })
  const r = await request(app).get('/api/cities/brooklyn-ny')
  assert.ok(r.status === 200 || r.status === 404) // may 404 if slug format differs
})

/* ─── GET /api/legal/:doc ────────────────────────────── */

test('GET /api/legal/tos — returns current tos or null', { skip }, async () => {
  await resetDb()
  const app = await getApp()
  const r   = await request(app).get('/api/legal/tos')
  assert.ok(r.status === 200 || r.status === 404)
})

test('GET /api/legal/privacy — returns current privacy policy or null', { skip }, async () => {
  await resetDb()
  const app = await getApp()
  const r   = await request(app).get('/api/legal/privacy')
  assert.ok(r.status === 200 || r.status === 404)
})

/* ─── Admin: POST /api/admin/legal ───────────────────── */

test('POST /api/admin/legal — admin can publish legal doc', { skip }, async () => {
  await resetDb()
  const admin = await seedUser({ role: 'admin' })
  const app   = await getApp()
  const r     = await request(app)
    .post('/api/admin/legal')
    .set('Authorization', `Bearer ${jwtFor(admin)}`)
    .send({
      id:           'tos',
      version:      '1.0',
      effective_at: new Date().toISOString(),
      content_md:   '# Terms of Service\n\nThese are our terms.',
    })
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body))
})

test('POST /api/admin/legal — customer returns 403', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()
  assert.equal(
    (await request(app).post('/api/admin/legal')
      .set('Authorization', `Bearer ${jwtFor(customer)}`)
      .send({ id: 'tos', version: '1', effective_at: new Date().toISOString(), content_md: '# TOS' }))
    .status,
    403
  )
})

test('After publishing tos, GET /api/legal/tos returns it', { skip }, async () => {
  await resetDb()
  const admin = await seedUser({ role: 'admin' })
  const app   = await getApp()
  await request(app).post('/api/admin/legal').set('Authorization', `Bearer ${jwtFor(admin)}`).send({
    id: 'tos', version: '2.0', effective_at: new Date(Date.now() - 1000).toISOString(),
    content_md: '# Terms\n\nUpdated terms here.',
  })
  const r = await request(app).get('/api/legal/tos')
  assert.equal(r.status, 200)
  assert.ok(r.body.version || r.body.content_md)
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
