// Promos + referrals + credit ledger — see specs/0070-promo-and-referral-codes.md.
//
// The validate endpoint is the read-only "what would this code do for me?"
// helper used at booking checkout. Actual redemption is performed during the
// booking creation flow (calls reservePromo + applyCredits via helper).

import { Router } from 'express'
import { z } from 'zod'
import { query, getClient } from '../db/index.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { idempotency } from '../middleware/idempotency.js'

const REFERRAL_REWARD_CENTS = 1000  // $10 default (spec 0070)
const CREDIT_EXPIRY_MONTHS  = 12

const ValidateSchema = z.object({
  code:                z.string().min(2).max(40),
  booking_total_cents: z.number().int().min(1),
})

const GrantSchema = z.object({
  user_id:      z.string().uuid(),
  amount_cents: z.number().int().min(1).max(100_000),
  notes:        z.string().max(500).optional(),
})

const CreatePromoSchema = z.object({
  code:               z.string().min(2).max(40),
  type:               z.enum(['percent','amount','referral']),
  percent_off:        z.number().int().min(1).max(100).optional(),
  amount_off_cents:   z.number().int().min(1).optional(),
  max_discount_cents: z.number().int().min(0).optional(),
  min_booking_cents:  z.number().int().min(0).optional(),
  redemptions_max:    z.number().int().min(1).optional(),
  per_user_limit:     z.number().int().min(1).optional(),
  valid_from:         z.string().datetime().optional(),
  valid_until:        z.string().datetime().optional(),
  first_booking_only: z.boolean().optional(),
})

/** Pure: compute the discount a code would apply to a booking total. */
function computeDiscount(promo, totalCents) {
  let discount = 0
  if (promo.type === 'percent') {
    discount = Math.floor(totalCents * (promo.percent_off ?? 0) / 100)
  } else {
    discount = promo.amount_off_cents ?? 0
  }
  if (promo.max_discount_cents != null) discount = Math.min(discount, promo.max_discount_cents)
  return Math.min(discount, totalCents)
}

/** Server-side validation that doesn't reserve. */
async function checkPromo(code, userId, totalCents) {
  const { rows } = await query(`SELECT * FROM promos WHERE code = $1`, [code.toUpperCase()])
  const promo = rows[0]
  if (!promo)          return { applies: false, reason: 'not_found' }
  if (!promo.is_active) return { applies: false, reason: 'inactive' }
  const now = new Date()
  if (promo.valid_from  && new Date(promo.valid_from)  > now) return { applies: false, reason: 'not_yet_valid' }
  if (promo.valid_until && new Date(promo.valid_until) < now) return { applies: false, reason: 'expired' }
  if (promo.min_booking_cents && totalCents < promo.min_booking_cents) {
    return { applies: false, reason: 'min_not_met', min_cents: promo.min_booking_cents }
  }
  if (promo.redemptions_max != null && promo.redemptions_used >= promo.redemptions_max) {
    return { applies: false, reason: 'redeemed_out' }
  }
  if (userId) {
    const used = await query(`SELECT COUNT(*)::int AS n FROM promo_redemptions WHERE promo_code = $1 AND user_id = $2`, [promo.code, userId])
    if (used.rows[0].n >= promo.per_user_limit) return { applies: false, reason: 'user_limit' }
    if (promo.first_booking_only) {
      const past = await query(`SELECT 1 FROM bookings WHERE customer_id = $1 AND status IN ('paid','completed') LIMIT 1`, [userId])
      if (past.rowCount > 0) return { applies: false, reason: 'first_booking_only' }
    }
    if (promo.referral_owner_id === userId) {
      return { applies: false, reason: 'own_referral_code' }
    }
  }
  return { applies: true, promo, discount_cents: computeDiscount(promo, totalCents) }
}

export const promosRouter = Router()

promosRouter.post('/validate', requireAuth, async (req, res, next) => {
  try {
    const data = ValidateSchema.parse(req.body)
    const result = await checkPromo(data.code, req.user.id, data.booking_total_cents)
    if (!result.applies) return res.json({ applies: false, reason: result.reason, ...(result.min_cents ? { min_cents: result.min_cents } : {}) })
    res.json({ applies: true, discount_cents: result.discount_cents })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/* GET /api/users/me/referral-code — auto-create the user's stable referral code. */
promosRouter.get('/me/referral-code', requireAuth, async (req, res, next) => {
  try {
    const existing = await query(`SELECT code FROM promos WHERE referral_owner_id = $1 LIMIT 1`, [req.user.id])
    if (existing.rows[0]) return res.json({ code: existing.rows[0].code })

    // Generate a short, friendly code: BEAM-<6 base32 chars from user id>.
    const base32 = req.user.id.replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase()
    const code = `BEAM${base32}`
    await query(
      `INSERT INTO promos (code, type, amount_off_cents, referral_owner_id, per_user_limit, first_booking_only)
       VALUES ($1, 'referral', $2, $3, 1, true)
       ON CONFLICT (code) DO NOTHING`,
      [code, REFERRAL_REWARD_CENTS, req.user.id]
    )
    res.json({ code })
  } catch (err) { next(err) }
})

export const creditsRouter = Router()

creditsRouter.get('/balance', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT COALESCE(SUM(amount_cents),0)::int AS balance
         FROM user_credits
        WHERE user_id = $1
          AND (expires_at IS NULL OR expires_at > now())`,
      [req.user.id]
    )
    res.json({ balance_cents: rows[0].balance })
  } catch (err) { next(err) }
})

creditsRouter.get('/history', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, amount_cents, source, source_ref, balance_after_cents, expires_at, created_at
         FROM user_credits WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 100`,
      [req.user.id]
    )
    res.json({ credits: rows })
  } catch (err) { next(err) }
})

/* ─── Admin authoring ────────────────────────────────────── */
export const adminPromosRouter = Router()

adminPromosRouter.get('/promos', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM promos ORDER BY created_at DESC LIMIT 200`)
    res.json({ promos: rows })
  } catch (err) { next(err) }
})

adminPromosRouter.post('/promos', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const data = CreatePromoSchema.parse(req.body)
    const row = await query(
      `INSERT INTO promos
         (code, type, percent_off, amount_off_cents, max_discount_cents,
          min_booking_cents, redemptions_max, per_user_limit,
          valid_from, valid_until, first_booking_only)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        data.code.toUpperCase(), data.type, data.percent_off ?? null, data.amount_off_cents ?? null,
        data.max_discount_cents ?? null, data.min_booking_cents ?? null,
        data.redemptions_max ?? null, data.per_user_limit ?? 1,
        data.valid_from ?? null, data.valid_until ?? null, data.first_booking_only ?? false,
      ]
    )
    res.status(201).json({ promo: row.rows[0] })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    if (err.code === '23505')    return res.status(409).json({ error: 'code_exists' })
    next(err)
  }
})

adminPromosRouter.patch('/promos/:code', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { is_active, valid_until } = req.body || {}
    const sets = []
    const params = [req.params.code.toUpperCase()]
    if (is_active   != null) { params.push(is_active);   sets.push(`is_active = $${params.length}`) }
    if (valid_until != null) { params.push(valid_until); sets.push(`valid_until = $${params.length}`) }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' })
    const { rows } = await query(
      `UPDATE promos SET ${sets.join(', ')} WHERE code = $1 RETURNING *`, params
    )
    if (!rows[0]) return res.status(404).json({ error: 'not_found' })
    res.json({ promo: rows[0] })
  } catch (err) { next(err) }
})

adminPromosRouter.post('/credits/grant', requireAuth, requireRole('admin'), idempotency(), async (req, res, next) => {
  try {
    const data = GrantSchema.parse(req.body)
    await applyCredit({
      userId: data.user_id, amount: data.amount_cents,
      source: 'admin_grant', sourceRef: `admin:${req.user.id}:${data.notes ?? ''}`.slice(0, 200),
    })
    res.json({ ok: true })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/** Helper: insert a credit row with running balance + 12-month expiry. */
export async function applyCredit({ userId, amount, source, sourceRef }) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { rows: bal } = await client.query(
      `SELECT COALESCE(SUM(amount_cents),0)::int AS b
         FROM user_credits WHERE user_id = $1
           AND (expires_at IS NULL OR expires_at > now())`,
      [userId]
    )
    const newBalance = (bal[0].b ?? 0) + amount
    const expiresAt = amount > 0 ? new Date(Date.now() + CREDIT_EXPIRY_MONTHS * 30 * 86400_000).toISOString() : null
    await client.query(
      `INSERT INTO user_credits (user_id, amount_cents, source, source_ref, balance_after_cents, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, amount, source, sourceRef ?? null, newBalance, expiresAt]
    )
    await client.query('COMMIT')
    return newBalance
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally { client.release() }
}

/** Helper for the booking creation flow. Reserves the promo (atomically
 *  bumps redemptions_used) and writes a redemption + discount on the booking
 *  row. Returns the discount in cents (0 if not applicable). */
export async function redeemPromoIfValid({ code, userId, bookingTotalCents, bookingId }) {
  if (!code) return 0
  const check = await checkPromo(code, userId, bookingTotalCents)
  if (!check.applies) return 0

  const client = await getClient()
  try {
    await client.query('BEGIN')
    // Atomic increment with cap check.
    const { rows } = await client.query(
      `UPDATE promos
          SET redemptions_used = redemptions_used + 1
        WHERE code = $1
          AND is_active = true
          AND (redemptions_max IS NULL OR redemptions_used < redemptions_max)
        RETURNING code, referral_owner_id`,
      [check.promo.code]
    )
    if (!rows.length) { await client.query('ROLLBACK'); return 0 }
    await client.query(
      `INSERT INTO promo_redemptions (promo_code, user_id, booking_id, discount_cents)
       VALUES ($1, $2, $3, $4)`,
      [check.promo.code, userId, bookingId ?? null, check.discount_cents]
    )
    await client.query('COMMIT')
    return check.discount_cents
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    return 0
  } finally { client.release() }
}

/** Credit a referral owner when the referee's first booking completes.
 *  Called from the payment_intent.succeeded webhook handler. */
export async function awardReferralCreditIfApplicable(bookingId) {
  const { rows } = await query(
    `SELECT b.customer_id, p.referral_owner_id
       FROM bookings b
       JOIN promos p ON p.code = b.promo_code
      WHERE b.id = $1 AND p.type = 'referral' AND p.referral_owner_id IS NOT NULL`,
    [bookingId]
  )
  const row = rows[0]
  if (!row) return
  // Only first paid booking triggers the reward (per-user-limit=1 on the
  // referral code already enforces this at redemption time).
  await applyCredit({
    userId: row.referral_owner_id,
    amount: REFERRAL_REWARD_CENTS,
    source: 'referral',
    sourceRef: `booking:${bookingId}:referee:${row.customer_id}`,
  })
}
