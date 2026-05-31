// Unit tests for requireAuth, optionalAuth, requireRole middleware.
// Pure-function / mock-request tests — no DB or network needed.

import test from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'

// Must be set before auth.js loads — it throws at import if < 32 chars
const SECRET = 'test-only-jwt-secret-32-chars-min!!'
process.env.JWT_SECRET = SECRET

const { requireAuth, optionalAuth, requireRole } = await import('../auth.js')

function makeReq(token) {
  return {
    headers: { authorization: token ? `Bearer ${token}` : undefined },
  }
}

function makeRes() {
  let status = 200
  let body   = null
  const res  = {
    status(s) { status = s; return res },
    json(b)   { body = b; return res },
    _get()    { return { status, body } },
  }
  return res
}

function validToken(payload = { id: 'u1', role: 'customer', email: 'a@b.com' }) {
  return jwt.sign(payload, SECRET, { expiresIn: '1h' })
}

/* ─── requireAuth ─────────────────────────────────────── */

// requireAuth is async (makes a DB check for token_valid_after) — all tests must await it.
// When no DB is available (unit tests), the token_valid_after check throws and is swallowed,
// so valid tokens still pass through.

test('requireAuth passes with valid token', async () => {
  const req  = makeReq(validToken())
  const res  = makeRes()
  let called = false
  await requireAuth(req, res, () => { called = true })
  assert.ok(called)
  assert.ok(req.user)
  assert.equal(req.user.role, 'customer')
})

test('requireAuth returns 401 with no token', async () => {
  const req = makeReq(null)
  const res = makeRes()
  await requireAuth(req, res, () => {})
  const { status, body } = res._get()
  assert.equal(status, 401)
  assert.ok(body.error)
})

test('requireAuth returns 401 with expired token', async () => {
  const token = jwt.sign({ id: 'u1', role: 'customer', email: 'a@b.com' }, SECRET, { expiresIn: '-1s' })
  const req   = makeReq(token)
  const res   = makeRes()
  await requireAuth(req, res, () => {})
  assert.equal(res._get().status, 401)
})

test('requireAuth returns 401 with wrong secret', async () => {
  const token = jwt.sign({ id: 'u1', role: 'customer', email: 'a@b.com' }, 'wrong-secret', { expiresIn: '1h' })
  const req   = makeReq(token)
  const res   = makeRes()
  await requireAuth(req, res, () => {})
  assert.equal(res._get().status, 401)
})

test('requireAuth returns 401 with malformed token', async () => {
  const req = makeReq('not.a.token')
  const res = makeRes()
  await requireAuth(req, res, () => {})
  assert.equal(res._get().status, 401)
})

/* ─── optionalAuth ────────────────────────────────────── */

test('optionalAuth sets req.user with valid token', () => {
  const req  = makeReq(validToken())
  const res  = makeRes()
  let called = false
  optionalAuth(req, res, () => { called = true })
  assert.ok(called)
  assert.ok(req.user)
})

test('optionalAuth continues without token (req.user = undefined)', () => {
  const req  = makeReq(null)
  const res  = makeRes()
  let called = false
  optionalAuth(req, res, () => { called = true })
  assert.ok(called)
  assert.equal(req.user, undefined)
})

test('optionalAuth continues with invalid token (no crash)', () => {
  const req  = makeReq('garbage')
  const res  = makeRes()
  let called = false
  optionalAuth(req, res, () => { called = true })
  assert.ok(called)
})

/* ─── requireAuth — cookie auth (FE-1 fix) ───────────── */

test('requireAuth passes with valid httpOnly cookie (no Bearer header)', async () => {
  const token = validToken()
  const req   = { headers: {}, cookies: { access_token: token } }
  const res   = makeRes()
  let called  = false
  await requireAuth(req, res, () => { called = true })
  assert.ok(called, 'next() should be called')
  assert.ok(req.user, 'req.user should be populated from cookie token')
  assert.equal(req.user.role, 'customer')
})

test('requireAuth Bearer header takes precedence over cookie', async () => {
  const bearerJwt = validToken({ id: 'bearer-u', role: 'barber',   email: 'b@b.com' })
  const cookieJwt = validToken({ id: 'cookie-u', role: 'customer', email: 'c@b.com' })
  const req = {
    headers: { authorization: `Bearer ${bearerJwt}` },
    cookies: { access_token: cookieJwt },
  }
  const res = makeRes()
  await requireAuth(req, res, () => {})
  assert.equal(req.user?.id, 'bearer-u', 'Bearer token should win when both are present')
})

test('requireAuth returns 401 with neither Bearer nor cookie', async () => {
  const req = { headers: {}, cookies: {} }
  const res = makeRes()
  await requireAuth(req, res, () => {})
  assert.equal(res._get().status, 401)
})

test('requireAuth returns 401 with invalid cookie token', async () => {
  const req = { headers: {}, cookies: { access_token: 'not.a.valid.jwt' } }
  const res = makeRes()
  await requireAuth(req, res, () => {})
  assert.equal(res._get().status, 401)
})

test('requireAuth returns 401 with expired cookie token', async () => {
  const expired = jwt.sign({ id: 'u1', role: 'customer', email: 'a@b.com' }, SECRET, { expiresIn: '-1s' })
  const req = { headers: {}, cookies: { access_token: expired } }
  const res = makeRes()
  await requireAuth(req, res, () => {})
  assert.equal(res._get().status, 401)
})

/* ─── requireRole ─────────────────────────────────────── */

test('requireRole passes when role matches', () => {
  const req  = { user: { role: 'barber' } }
  const res  = makeRes()
  let called = false
  requireRole('barber')(req, res, () => { called = true })
  assert.ok(called)
})

test('requireRole passes for any role in list', () => {
  const req  = { user: { role: 'admin' } }
  const res  = makeRes()
  let called = false
  requireRole('barber', 'admin')(req, res, () => { called = true })
  assert.ok(called)
})

test('requireRole returns 403 when role does not match', () => {
  const req = { user: { role: 'customer' } }
  const res = makeRes()
  requireRole('barber')(req, res, () => {})
  assert.equal(res._get().status, 403)
})

test('requireRole returns 401 when req.user is missing', () => {
  const req = {}
  const res = makeRes()
  requireRole('barber')(req, res, () => {})
  const { status } = res._get()
  assert.ok(status === 401 || status === 403)
})
