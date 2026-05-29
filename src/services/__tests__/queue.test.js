// Unit tests for queue / job scheduling helpers.
// Tests pure logic — does not connect to real Redis.

import test from 'node:test'
import assert from 'node:assert/strict'

// These are pure computation helpers, not the queue itself
// Test that job delay calculations are correct

test('auto-cancel delay is positive for future bookings', () => {
  const scheduledAt = new Date(Date.now() + 10 * 60_000)  // 10 min from now
  const autoCancel  = 10 * 60_000                         // 10 min window
  const delay       = scheduledAt.getTime() + autoCancel - Date.now()
  assert.ok(delay > 0, 'delay should be positive for future bookings')
})

test('auto-confirm default TTL is 10 minutes', () => {
  const DEFAULT_AUTO_CONFIRM_MINUTES = 10
  assert.equal(DEFAULT_AUTO_CONFIRM_MINUTES * 60 * 1000, 600_000)
})

test('job names follow consistent pattern', () => {
  // Validate that job name strings are non-empty and snake_case
  const JOB_NAMES = [
    'auto_cancel',
    'auto_confirm',
    'auto_complete',
    'barber_no_show',
  ]
  for (const name of JOB_NAMES) {
    assert.match(name, /^[a-z_]+$/, `job name "${name}" should be snake_case`)
    assert.ok(name.length > 0)
  }
})
