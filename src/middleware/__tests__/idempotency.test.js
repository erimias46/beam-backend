// Smoke tests for the idempotency middleware. Uses node:test, the built-in
// runner, so no extra deps are needed. Run with:
//   node --test src/middleware/__tests__/idempotency.test.js
//
// These are pure-function tests. The route-level integration test (double-tap
// /api/bookings → 1 booking) is exercised in spec 0010's acceptance criteria
// against a live DB; we'll wire that up when the formal test harness lands in
// spec 0004.

import test from 'node:test'
import assert from 'node:assert/strict'
import { requestHash, newIdempotencyKey } from '../idempotency.js'

test('requestHash is deterministic regardless of key order', () => {
  const a = requestHash({ b: 2, a: 1, nested: { y: 'y', x: 'x' } })
  const b = requestHash({ a: 1, nested: { x: 'x', y: 'y' }, b: 2 })
  assert.equal(a, b)
})

test('requestHash distinguishes different payloads', () => {
  assert.notEqual(
    requestHash({ amount: 100 }),
    requestHash({ amount: 101 }),
  )
})

test('requestHash handles arrays and nulls', () => {
  assert.equal(
    requestHash({ items: [1, 2, 3], note: null }),
    requestHash({ note: null, items: [1, 2, 3] }),
  )
  assert.notEqual(
    requestHash({ items: [1, 2, 3] }),
    requestHash({ items: [3, 2, 1] }),     // array order matters
  )
})

test('requestHash handles empty body', () => {
  // {} and undefined body both canonicalize to the same hash (the spec says
  // the middleware coerces undefined → {}).
  assert.equal(requestHash({}), requestHash(undefined))
})

test('newIdempotencyKey returns a unique-looking string', () => {
  const a = newIdempotencyKey()
  const b = newIdempotencyKey()
  assert.notEqual(a, b)
  assert.ok(a.length >= 16, `expected ≥16 chars, got ${a.length}`)
})
