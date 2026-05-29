import { query } from '../db/index.js'

/* ─── Defaults ───────────────────────────────────────────────────────────────
   These are used when no row exists in platform_settings yet.
   All values stored as TEXT; cast on the way out.
*/
export const SETTING_DEFAULTS = {
  platform_fee_bps:                process.env.PLATFORM_FEE_BPS || '1500', // initial default only; DB value wins once set
  auto_cancel_minutes:             '10',     // minutes barber has to accept before auto-cancel
  auto_complete_hours:             '2',      // hours after scheduled_at before auto-complete
  max_advance_days:                '30',     // how far ahead a customer can book
  min_notice_hours:                '1',      // minimum hours before appointment
  max_price_cents:                 '100000', // $1,000 booking cap
  barber_signups_enabled:          'true',
  customer_signups_enabled:        'true',
  require_stripe_for_availability: 'false',
  refund_window_hours:             '24',     // spec 0012 — customer self-refund window after 'paid'

  // Cancellation policy (spec 0013). Tiers compared by minutes-until-scheduled.
  // tier 1: >= tier_1_minutes away → tier_1_bps
  // tier 2: between tier_2_minutes and tier_1_minutes → tier_2_bps
  // tier 3: <= tier_2_minutes (incl. after scheduled_at) → tier_3_bps
  cancellation_policy_enabled:     'false',   // feature flag — defaults off until pre-launch email sent
  cancel_fee_tier_1_minutes:       '60',
  cancel_fee_tier_1_bps:           '0',
  cancel_fee_tier_2_minutes:       '15',
  cancel_fee_tier_2_bps:           '2500',    // 25%
  cancel_fee_tier_3_bps:           '5000',    // 50%
  barber_no_show_deadline_minutes: '15',
  customer_no_show_fee_bps:        '5000',    // 50% paid to barber on customer no-show

  // Trust & safety
  identity_required_for_accept:    'true',    // spec 0020 — block /accept if barber not verified
  customer_rating_window_hours:    '24',      // spec 0021 — barber must rate customer within N hrs of completion
  auto_confirm_minutes:            '10',      // spec 0023 — minutes before awaiting_confirmation auto-confirms
  eta_avg_kmh:                     '40',      // spec 0031 — straight-line speed for ETA calc (no routing API)
  auto_offline_minutes:            '15',      // spec 0050 — sweep flips is_available=false after N min idle
}

// Ensure the table exists (called once at startup)
export async function initSettingsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

// Returns all settings merged with defaults (DB wins)
export async function getSettings() {
  const { rows } = await query(`SELECT key, value FROM platform_settings`)
  const db = Object.fromEntries(rows.map(r => [r.key, r.value]))
  return { ...SETTING_DEFAULTS, ...db }
}

// Returns a single setting value as a string
export async function getSetting(key) {
  const { rows } = await query(
    `SELECT value FROM platform_settings WHERE key = $1`, [key]
  )
  return rows[0]?.value ?? SETTING_DEFAULTS[key] ?? null
}

// Upserts one or more settings
export async function setSettings(updates) {
  const entries = Object.entries(updates)
  for (const [key, value] of entries) {
    if (!(key in SETTING_DEFAULTS)) continue // ignore unknown keys
    await query(`
      INSERT INTO platform_settings (key, value)
      VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
    `, [key, String(value)])
  }
}
