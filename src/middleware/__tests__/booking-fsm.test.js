// Unit tests for the booking FSM transition logic.
// Pure function tests — no DB or network needed.

import test from 'node:test'
import assert from 'node:assert/strict'
import { canTransition, assertTransition } from '../booking-fsm.js'

/* ─── canTransition ───────────────────────────────────── */

test('requested → accepted is valid', () => {
  assert.ok(canTransition('requested', 'accepted'))
})

test('requested → declined is valid', () => {
  assert.ok(canTransition('requested', 'declined'))
})

test('requested → cancelled is valid', () => {
  assert.ok(canTransition('requested', 'cancelled'))
})

test('accepted → in_progress is valid', () => {
  assert.ok(canTransition('accepted', 'in_progress'))
})

test('accepted → cancelled is valid', () => {
  assert.ok(canTransition('accepted', 'cancelled'))
})

test('in_progress → awaiting_confirmation is valid', () => {
  assert.ok(canTransition('in_progress', 'awaiting_confirmation'))
})

test('awaiting_confirmation → completed is valid', () => {
  assert.ok(canTransition('awaiting_confirmation', 'completed'))
})

test('completed → paid is valid', () => {
  assert.ok(canTransition('completed', 'paid'))
})

// Terminal states
test('paid → anything is invalid', () => {
  assert.ok(!canTransition('paid', 'cancelled'))
  assert.ok(!canTransition('paid', 'requested'))
  assert.ok(!canTransition('paid', 'completed'))
})

test('declined → anything is invalid', () => {
  assert.ok(!canTransition('declined', 'accepted'))
  assert.ok(!canTransition('declined', 'requested'))
})

test('cancelled → anything is invalid', () => {
  assert.ok(!canTransition('cancelled', 'accepted'))
  assert.ok(!canTransition('cancelled', 'in_progress'))
})

// Skip-step transitions
test('requested → completed is invalid (must follow FSM order)', () => {
  assert.ok(!canTransition('requested', 'completed'))
})

test('requested → in_progress is invalid', () => {
  assert.ok(!canTransition('requested', 'in_progress'))
})

test('accepted → completed is invalid (must go via in_progress)', () => {
  assert.ok(!canTransition('accepted', 'completed'))
})

test('in_progress → accepted (backward) is invalid', () => {
  assert.ok(!canTransition('in_progress', 'accepted'))
})

test('awaiting_confirmation → accepted (backward) is invalid', () => {
  assert.ok(!canTransition('awaiting_confirmation', 'accepted'))
})

/* ─── assertTransition ────────────────────────────────── */

function makeRes() {
  let status = 200, body = null
  const res = {
    status(s) { status = s; return res },
    json(b)   { body = b; return res },
    _get()    { return { status, body } },
  }
  return res
}

test('assertTransition returns true for valid transition and does not write response', () => {
  const res = makeRes()
  const ok  = assertTransition('requested', 'accepted', res)
  assert.ok(ok)
  assert.equal(res._get().status, 200) // untouched
})

test('assertTransition returns false and sends 422 for invalid transition', () => {
  const res = makeRes()
  const ok  = assertTransition('paid', 'accepted', res)
  assert.ok(!ok)
  const { status, body } = res._get()
  assert.equal(status, 422)
  assert.ok(body.error)
  assert.ok(Array.isArray(body.allowed))
})

test('assertTransition 422 body includes the current status', () => {
  const res = makeRes()
  assertTransition('completed', 'requested', res)
  const { body } = res._get()
  assert.ok(body.allowed.length === 1) // completed → [paid]
  assert.equal(body.allowed[0], 'paid')
})
