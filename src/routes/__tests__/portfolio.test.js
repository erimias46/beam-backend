// Integration tests for /api/barbers/portfolio (spec 0045).

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

async function seedPortfolioItem(barberId) {
  const { rows } = await testPool.query(
    `INSERT INTO barber_portfolio (barber_id, image_url, caption, position)
     VALUES ($1, 'https://example.com/photo.jpg', 'Test cut', 0) RETURNING *`,
    [barberId]
  )
  return rows[0]
}

/* ─── GET /api/barbers/:id/portfolio ─────────────────── */

test('GET /api/barbers/:id/portfolio — public, returns portfolio', { skip }, async () => {
  await resetDb()
  const barber = await seedBarber()
  const app    = await getApp()
  const r      = await request(app).get(`/api/barbers/${barber.id}/portfolio`)
  assert.equal(r.status, 200)
  const items = r.body.portfolio ?? r.body
  assert.ok(Array.isArray(items))
})

test('GET /api/barbers/:id/portfolio — no auth required', { skip }, async () => {
  await resetDb()
  const barber = await seedBarber()
  const app    = await getApp()
  assert.equal((await request(app).get(`/api/barbers/${barber.id}/portfolio`)).status, 200)
})

/* ─── PATCH /api/barbers/portfolio/:id ───────────────── */

test('PATCH /api/barbers/portfolio/:id — barber can update caption', { skip }, async () => {
  await resetDb()
  const barber = await seedBarber()
  const item   = await seedPortfolioItem(barber.id)
  const app    = await getApp()
  const r      = await request(app)
    .patch(`/api/barbers/portfolio/${item.id}`)
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({ caption: 'Updated caption' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
})

test('PATCH /api/barbers/portfolio/:id — customer returns 403', { skip }, async () => {
  await resetDb()
  const barber   = await seedBarber()
  const customer = await seedUser({ role: 'customer' })
  const item     = await seedPortfolioItem(barber.id)
  const app      = await getApp()
  assert.equal(
    (await request(app).patch(`/api/barbers/portfolio/${item.id}`)
      .set('Authorization', `Bearer ${jwtFor(customer)}`).send({ caption: 'hack' })).status,
    403
  )
})

/* ─── DELETE /api/barbers/portfolio/:id ──────────────── */

test('DELETE /api/barbers/portfolio/:id — barber can delete own item', { skip }, async () => {
  await resetDb()
  const barber = await seedBarber()
  const item   = await seedPortfolioItem(barber.id)
  const app    = await getApp()
  const r      = await request(app)
    .delete(`/api/barbers/portfolio/${item.id}`)
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
  assert.ok(r.status === 200 || r.status === 204)
})

test('DELETE /api/barbers/portfolio/:id — unrelated barber returns 403 or 404', { skip }, async () => {
  await resetDb()
  const barber1 = await seedBarber()
  const barber2 = await seedBarber()
  const item    = await seedPortfolioItem(barber1.id)
  const app     = await getApp()
  const r       = await request(app)
    .delete(`/api/barbers/portfolio/${item.id}`)
    .set('Authorization', `Bearer ${jwtFor(barber2)}`)
  assert.ok(r.status === 403 || r.status === 404)
})

/* ─── POST /api/barbers/portfolio/reorder ────────────── */

test('POST /api/barbers/portfolio/reorder — barber can reorder', { skip }, async () => {
  await resetDb()
  const barber = await seedBarber()
  const i1     = await seedPortfolioItem(barber.id)
  const i2     = await seedPortfolioItem(barber.id)
  const app    = await getApp()
  const r      = await request(app)
    .post('/api/barbers/portfolio/reorder')
    .set('Authorization', `Bearer ${jwtFor(barber)}`)
    .send({ ids: [i2.id, i1.id] })
  assert.ok(r.status === 200 || r.status === 204, JSON.stringify(r.body))
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
