// Platform fee — single source of truth is the runtime `platform_fee_bps`
// admin setting (platform_settings table). Admins change it via
// PATCH /api/admin/settings with no redeploy.
//
// The PLATFORM_FEE_BPS env var only seeds the *initial* default when no DB
// row exists yet (see SETTING_DEFAULTS in services/settings.js). Once a value
// is stored in platform_settings, the DB value always wins.

import { getSetting } from './services/settings.js'

const FALLBACK_FEE_BPS = 1500 // 15% — last-resort default if the setting is missing/invalid

/** Live platform fee in basis points (100 bps = 1%). Reads the admin setting. */
export async function getPlatformFeeBps() {
  const bps = parseInt(await getSetting('platform_fee_bps'), 10)
  return Number.isFinite(bps) ? bps : FALLBACK_FEE_BPS
}

/** Barber's share as a multiplier (e.g. 0.85 when the fee is 15%). */
export async function getBarberShare() {
  return 1 - (await getPlatformFeeBps()) / 10_000
}
