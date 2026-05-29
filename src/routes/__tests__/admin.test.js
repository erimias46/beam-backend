// Integration tests for /api/admin routes — access control and core operations.

import test from 'node:test'
import assert from 'node:assert/strict'
import { pointAppPoolAtTestDb, resetDb, seedUser, closeAll, testPool } from '../../__tests__/helpers/db.js'

pointAppPoolAtTestDb()
process.env.MASTER_OTP = '000000'

const { getApp, jwtFor } = await import('../../__tests__/helpers/app.js')
const request = (await import('supertest')).default
const dbOk = await testPool.query('SELECT 1').then(() => true).catch(() => false)
const skip  = !dbOk

/* ─── Access control — non-admin gets 403 everywhere ────── */

const ADMIN_ROUTES = [
  { method: 'get',  path: '/api/admin/users'     },
  { method: 'get',  path: '/api/admin/bookings'  },
  { method: 'get',  path: '/api/admin/reports'   },
  { method: 'get',  path: '/api/admin/promos'    },
]

for (const { method, path } of ADMIN_ROUTES) {
  test(`${method.toUpperCase()} ${path} — unauthenticated returns 401`, { skip }, async () => {
    const app = await getApp()
    const r   = await request(app)[method](path)
    assert.equal(r.status, 401)
  })

  test(`${method.toUpperCase()} ${path} — customer returns 403`, { skip }, async () => {
    await resetDb()
    const customer = await seedUser({ role: 'customer' })
    const app      = await getApp()
    const r        = await request(app)[method](path).set('Authorization', `Bearer ${jwtFor(customer)}`)
    assert.equal(r.status, 403)
  })

  test(`${method.toUpperCase()} ${path} — barber returns 403`, { skip }, async () => {
    await resetDb()
    const barber = await seedUser({ role: 'barber' })
    await testPool.query(`INSERT INTO barber_profiles (user_id, is_available, services) VALUES ($1, true, '[]'::jsonb)`, [barber.id])
    const app    = await getApp()
    const r      = await request(app)[method](path).set('Authorization', `Bearer ${jwtFor(barber)}`)
    assert.equal(r.status, 403)
  })

  test(`${method.toUpperCase()} ${path} — admin gets 200`, { skip }, async () => {
    await resetDb()
    const admin = await seedUser({ role: 'admin' })
    const app   = await getApp()
    const r     = await request(app)[method](path).set('Authorization', `Bearer ${jwtFor(admin)}`)
    assert.ok(r.status === 200 || r.status === 204, `expected 200/204 got ${r.status}: ${JSON.stringify(r.body)}`)
  })
}

/* ─── GET /api/metrics — admin only ──────────────────── */

test('GET /api/metrics — admin gets process metrics', { skip }, async () => {
  await resetDb()
  const admin = await seedUser({ role: 'admin' })
  const app   = await getApp()
  const r     = await request(app).get('/api/metrics').set('Authorization', `Bearer ${jwtFor(admin)}`)
  assert.equal(r.status, 200)
})

test('GET /api/metrics — customer returns 403', { skip }, async () => {
  await resetDb()
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()
  const r        = await request(app).get('/api/metrics').set('Authorization', `Bearer ${jwtFor(customer)}`)
  assert.equal(r.status, 403)
})

/* ─── Admin promos CRUD ───────────────────────────────── */

test('Admin can create a promo code', { skip }, async () => {
  await resetDb()
  const admin = await seedUser({ role: 'admin' })
  const app   = await getApp()
  const r     = await request(app)
    .post('/api/admin/promos')
    .set('Authorization', `Bearer ${jwtFor(admin)}`)
    .send({
      code:             'ADMIN10',
      discount_bps:     1000,
      max_redemptions:  50,
      valid_from:       new Date(Date.now() - 1000).toISOString(),
    })
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body))
})

test('Admin can list promos', { skip }, async () => {
  await resetDb()
  const admin = await seedUser({ role: 'admin' })
  const app   = await getApp()
  const r     = await request(app).get('/api/admin/promos').set('Authorization', `Bearer ${jwtFor(admin)}`)
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body.promos ?? r.body))
})

/* ─── Admin can grant credits ─────────────────────────── */

test('Admin can grant credits to a user', { skip }, async () => {
  await resetDb()
  const admin    = await seedUser({ role: 'admin' })
  const customer = await seedUser({ role: 'customer' })
  const app      = await getApp()
  const r        = await request(app)
    .post('/api/admin/credits/grant')
    .set('Authorization', `Bearer ${jwtFor(admin)}`)
    .send({ user_id: customer.id, amount_cents: 500, reason: 'test_grant' })
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body))
})

test.after(async () => {
  await closeAll()
  const { pool }       = await import('../../db/index.js')
  const { closeQueue } = await import('../../services/queue.js')
  await closeQueue().catch(() => {})
  await pool.end().catch(() => {})
})
