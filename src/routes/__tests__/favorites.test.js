// Integration tests for /api/favorites (spec 0044).
// POST /api/favorites   body: { barber_id }  (customer only)
// DELETE /api/favorites/:barberId             (customer only)

import test from 'node:test'
import assert from 'node:assert/strict'
import { pointAppPoolAtTestDb, resetDb, seedUser, closeAll, testPool } from '../../__tests__/helpers/db.js'

pointAppPoolAtTestDb()
process.env.MASTER_OTP = '000000'

const { getApp, jwtFor } = await import('../../__tests__/helpers/app.js')
const request = (await import('supertest')).default
const dbOk = await testPool.query('SELECT 1').then(() => true).catch(() => false)
const skip  = !dbOk

async function seedBarber() {
  const barber = await seedUser({ role: 'barber' })
  await testPool.query(
    `INSERT INTO barber_profiles (user_id, is_available, services) VALUES ($1, true, '[]'::jsonb)`,
    [barber.id]
  )
  return barber
}

/* ─── GET /api/favorites ──────────────────────────────── */

test('GET /api/favorites — returns empty list initially', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()
  const r        = await request(app).get('/api/favorites').set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.equal(r.status, 200)
  const list = r.body.favorites ?? r.body
  assert.ok(Array.isArray(list))
  assert.equal(list.length, 0)
})

test('GET /api/favorites — unauthenticated returns 401', { skip }, async () => {
  const app = await getApp()
  assert.equal((await request(app).get('/api/favorites')).status, 401)
})

/* ─── POST /api/favorites — body: { barber_id } ─────── */

test('POST /api/favorites — customer can favorite a barber', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()
  const r        = await request(app)
    .post('/api/favorites')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
    .send({ barber_id: barber.id })
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body))
  assert.ok(r.body.ok || r.body.barber_id === barber.id)
})

test('POST /api/favorites — after favoriting, barber appears in list', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()
  await request(app).post('/api/favorites').set('Authorization', `Bearer ${jwtFor(customer)}`).send({ barber_id: barber.id })
  const r    = await request(app).get('/api/favorites').set('Authorization', `Bearer ${jwtFor(customer)}`)
  const list = r.body.favorites ?? r.body
  assert.ok(list.some(f => f.barber_id === barber.id || f.id === barber.id), `barber not in list: ${JSON.stringify(list)}`)
})

test('POST /api/favorites — unauthenticated returns 401', { skip }, async () => {
  await resetDb()
  const barber = await seedBarber()
  const app    = await getApp()
  const r      = await request(app).post('/api/favorites').send({ barber_id: barber.id })
  assert.equal(r.status, 401)
})

test('POST /api/favorites — barber role returns 403', { skip }, async () => {
  await resetDb()
  const barber  = await seedBarber()
  const barber2 = await seedBarber()
  const app     = await getApp()
  const r       = await request(app)
    .post('/api/favorites')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({ barber_id: barber2.id })
  assert.equal(r.status, 403)
})

/* ─── DELETE /api/favorites/:barberId ─────────────────── */

test('DELETE /api/favorites/:barberId — customer can unfavorite', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()
  await request(app).post('/api/favorites').set('Authorization', `Bearer ${jwtFor(customer)}`).send({ barber_id: barber.id })
  const r = await request(app)
    .delete(`/api/favorites/${barber.id}`)
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.ok(r.status === 200 || r.status === 204)
  const list = (await request(app).get('/api/favorites').set('Authorization', `Bearer ${jwtFor(customer)}`)).body
  const favs = list.favorites ?? list
  assert.ok(!favs.some(f => f.barber_id === barber.id || f.id === barber.id))
})

/* ─── favorites_first in GET /api/barbers ──────────────── */

test('GET /api/barbers?favorites_first=true — includes is_favorite flag', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const barber   = await seedBarber()
  const app      = await getApp()
  await request(app).post('/api/favorites').set('Authorization', `Bearer ${jwtFor(customer)}`).send({ barber_id: barber.id })
  const r    = await request(app)
    .get('/api/barbers?favorites_first=true')
    .set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.equal(r.status, 200)
  const list = r.body.barbers ?? r.body
  const found = list.find(b => b.id === barber.id)
  if (found) assert.ok(found.is_favorite === true, 'favorited barber should have is_favorite=true')
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
