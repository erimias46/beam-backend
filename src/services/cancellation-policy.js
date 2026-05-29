// Cancellation policy fee calculator — see specs/0013-cancellation-policy.md.
//
// Pure functions plus a single async wrapper that reads the platform_settings
// table. Kept separate from the route so it's easy to unit test the math
// without spinning up Express.

import { getSettings } from './settings.js'

/** Compute fee in cents from policy + booking context. Pure. */
export function computeCancellationFee({
  policy,                  // { enabled, tier_1_minutes, tier_1_bps, tier_2_minutes, tier_2_bps, tier_3_bps }
  status,                  // booking status when cancel was initiated
  scheduledAtMs,           // booking.scheduled_at as ms timestamp
  nowMs = Date.now(),
  priceCents,
}) {
  // Free cancellation when still in `requested` — no PI authorized yet, no
  // money to capture even if we wanted to.
  if (status === 'requested') {
    return { fee_cents: 0, tier: 0, minutes_until: Math.round((scheduledAtMs - nowMs) / 60000), reason: 'no_pi_yet' }
  }

  // Free when policy is disabled by the feature flag.
  if (!policy.enabled) {
    return { fee_cents: 0, tier: 0, minutes_until: Math.round((scheduledAtMs - nowMs) / 60000), reason: 'policy_disabled' }
  }

  const minutesUntil = (scheduledAtMs - nowMs) / 60000

  let tier, bps
  if (minutesUntil >= policy.tier_1_minutes) {
    tier = 1; bps = policy.tier_1_bps
  } else if (minutesUntil >= policy.tier_2_minutes) {
    tier = 2; bps = policy.tier_2_bps
  } else {
    tier = 3; bps = policy.tier_3_bps
  }

  const fee = Math.round((priceCents * bps) / 10_000)
  return { fee_cents: fee, tier, minutes_until: Math.round(minutesUntil), reason: 'tiered' }
}

/** Async wrapper that pulls settings from DB and applies the policy. */
export async function getCancellationFee(booking, nowMs = Date.now()) {
  const s = await getSettings()
  const policy = {
    enabled:        s.cancellation_policy_enabled === 'true',
    tier_1_minutes: parseInt(s.cancel_fee_tier_1_minutes),
    tier_1_bps:     parseInt(s.cancel_fee_tier_1_bps),
    tier_2_minutes: parseInt(s.cancel_fee_tier_2_minutes),
    tier_2_bps:     parseInt(s.cancel_fee_tier_2_bps),
    tier_3_bps:     parseInt(s.cancel_fee_tier_3_bps),
  }
  return computeCancellationFee({
    policy,
    status:         booking.status,
    scheduledAtMs:  new Date(booking.scheduled_at).getTime(),
    nowMs,
    priceCents:     booking.price_cents,
  })
}
