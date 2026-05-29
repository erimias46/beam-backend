// Unit tests for the cancellation fee tiers. See specs/0013-cancellation-policy.md.

import test from 'node:test'
import assert from 'node:assert/strict'
import { computeCancellationFee } from '../cancellation-policy.js'

const POLICY = {
  enabled:        true,
  tier_1_minutes: 60,
  tier_1_bps:     0,
  tier_2_minutes: 15,
  tier_2_bps:     2500,
  tier_3_bps:     5000,
}

const PRICE = 4000     // $40

const baseInput = (overrides) => ({
  policy: POLICY,
  status: 'accepted',
  scheduledAtMs: 1000_000,
  nowMs:        1000_000 - 30 * 60_000, // 30 min before scheduled
  priceCents:   PRICE,
  ...overrides,
})

test('requested status → no fee even if last-minute', () => {
  const r = computeCancellationFee(baseInput({ status: 'requested', nowMs: 1000_000 - 1 }))
  assert.equal(r.fee_cents, 0)
  assert.equal(r.tier, 0)
  assert.equal(r.reason, 'no_pi_yet')
})

test('policy disabled → no fee', () => {
  const r = computeCancellationFee(baseInput({ policy: { ...POLICY, enabled: false } }))
  assert.equal(r.fee_cents, 0)
  assert.equal(r.reason, 'policy_disabled')
})

test('>60 min away → tier 1, free', () => {
  const r = computeCancellationFee(baseInput({ nowMs: 1000_000 - 90 * 60_000 }))
  assert.equal(r.fee_cents, 0)
  assert.equal(r.tier, 1)
})

test('30 min away → tier 2 (25%) = $10', () => {
  const r = computeCancellationFee(baseInput({ nowMs: 1000_000 - 30 * 60_000 }))
  assert.equal(r.fee_cents, 1000)
  assert.equal(r.tier, 2)
})

test('5 min away → tier 3 (50%) = $20', () => {
  const r = computeCancellationFee(baseInput({ nowMs: 1000_000 - 5 * 60_000 }))
  assert.equal(r.fee_cents, 2000)
  assert.equal(r.tier, 3)
})

test('after scheduled time → tier 3 (50%)', () => {
  const r = computeCancellationFee(baseInput({ nowMs: 1000_000 + 60_000 }))
  assert.equal(r.fee_cents, 2000)
  assert.equal(r.tier, 3)
})
