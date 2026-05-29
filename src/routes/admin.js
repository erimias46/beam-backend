import { Router } from 'express'
import Stripe from 'stripe'
import { query } from '../db/index.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { getSettings, setSettings, SETTING_DEFAULTS } from '../services/settings.js'
import { reprocessEvent } from './stripe.js'

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null

const router = Router()
const guard = [requireAuth, requireRole('admin')]

/* ─── Stats ──────────────────────────────────────────────── */
router.get('/stats', guard, async (req, res, next) => {
  try {
    const [users, bookings, gmvAll, barbers, pending, activeBarbers, usersToday, revToday, revWeek, revMonth] = await Promise.all([
      query(`SELECT COUNT(*) FROM users`),
      query(`SELECT COUNT(*), status FROM bookings GROUP BY status`),
      query(`SELECT COALESCE(SUM(price_cents),0) AS total FROM bookings WHERE status IN ('completed','paid')`),
      query(`SELECT COUNT(*) FROM barber_profiles`),
      query(`SELECT COUNT(*) FROM bookings WHERE status = 'requested'`),
      query(`SELECT COUNT(*) FROM barber_profiles WHERE is_available = true`),
      query(`SELECT COUNT(*) FROM users WHERE created_at >= CURRENT_DATE`),
      query(`SELECT COALESCE(SUM(price_cents),0) AS total FROM bookings WHERE status IN ('completed','paid') AND updated_at >= CURRENT_DATE`),
      query(`SELECT COALESCE(SUM(price_cents),0) AS total FROM bookings WHERE status IN ('completed','paid') AND updated_at >= DATE_TRUNC('week', NOW())`),
      query(`SELECT COALESCE(SUM(price_cents),0) AS total FROM bookings WHERE status IN ('completed','paid') AND updated_at >= DATE_TRUNC('month', NOW())`),
    ])

    const byStatus = {}
    bookings.rows.forEach(r => { byStatus[r.status] = parseInt(r.count) })

    const [signups, revenueDaily] = await Promise.all([
      query(`
        SELECT DATE_TRUNC('day', created_at)::date AS day, COUNT(*)::int AS count
        FROM users WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY 1 ORDER BY 1
      `),
      query(`
        SELECT DATE_TRUNC('day', updated_at)::date AS day,
               COALESCE(SUM(price_cents),0)::bigint AS revenue_cents
        FROM bookings
        WHERE status IN ('completed','paid') AND updated_at >= NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 1
      `),
    ])

    res.json({
      total_users:      parseInt(users.rows[0].count),
      total_barbers:    parseInt(barbers.rows[0].count),
      active_barbers:   parseInt(activeBarbers.rows[0].count),
      users_today:      parseInt(usersToday.rows[0].count),
      bookings_by_status: byStatus,
      total_bookings:   Object.values(byStatus).reduce((s, v) => s + v, 0),
      gmv_cents:        parseInt(gmvAll.rows[0].total),
      revenue_today:    parseInt(revToday.rows[0].total),
      revenue_week:     parseInt(revWeek.rows[0].total),
      revenue_month:    parseInt(revMonth.rows[0].total),
      pending_requests: parseInt(pending.rows[0].count),
      signups_last_7d:  signups.rows,
      revenue_last_30d: revenueDaily.rows,
    })
  } catch (err) { next(err) }
})

/* ─── Users ──────────────────────────────────────────────── */
router.get('/users', guard, async (req, res, next) => {
  try {
    const { search, role, suspended, limit = 50, offset = 0 } = req.query
    const params = []
    const conditions = []

    if (search) {
      params.push(`%${search}%`)
      conditions.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length})`)
    }
    if (role)      { params.push(role);            conditions.push(`u.role = $${params.length}`) }
    if (suspended) { params.push(suspended === 'true'); conditions.push(`u.is_suspended = $${params.length}`) }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(parseInt(limit), parseInt(offset))

    const { rows } = await query(`
      SELECT u.id, u.name, u.email, u.phone, u.role, u.is_suspended, u.created_at, u.last_active_at,
             b.rating_avg, b.rating_count, b.is_available, b.stripe_charges_enabled,
             (SELECT COUNT(*)::int FROM bookings WHERE customer_id = u.id) AS booking_count
      FROM users u
      LEFT JOIN barber_profiles b ON b.user_id = u.id
      ${where}
      ORDER BY u.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params)

    const total = await query(`SELECT COUNT(*) FROM users u ${where}`, params.slice(0, -2))
    res.json({ users: rows, total: parseInt(total.rows[0].count) })
  } catch (err) { next(err) }
})

router.patch('/users/:id/suspend', guard, async (req, res, next) => {
  try {
    const { suspended } = req.body
    await query(`UPDATE users SET is_suspended = $1 WHERE id = $2`, [!!suspended, req.params.id])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

router.patch('/users/:id/role', guard, async (req, res, next) => {
  try {
    const { role } = req.body
    if (!['customer', 'barber', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' })
    await query(`UPDATE users SET role = $1 WHERE id = $2`, [role, req.params.id])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

router.delete('/users/:id', guard, async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' })
    await query(`DELETE FROM users WHERE id = $1`, [req.params.id])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

/* ─── Bookings ───────────────────────────────────────────── */
router.get('/bookings', guard, async (req, res, next) => {
  try {
    const { status, search, limit = 50, offset = 0 } = req.query
    const params = []
    const conditions = []

    if (status) { params.push(status); conditions.push(`b.status = $${params.length}`) }
    if (search) {
      params.push(`%${search}%`)
      conditions.push(`(c.name ILIKE $${params.length} OR br.name ILIKE $${params.length} OR b.service_type ILIKE $${params.length})`)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(parseInt(limit), parseInt(offset))

    const { rows } = await query(`
      SELECT b.id, b.service_type, b.price_cents, b.status, b.scheduled_at, b.address,
             b.created_at, b.updated_at,
             c.name AS customer_name, c.email AS customer_email,
             br.name AS barber_name
      FROM bookings b
      LEFT JOIN users c  ON c.id = b.customer_id
      LEFT JOIN users br ON br.id = b.barber_id
      ${where}
      ORDER BY b.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params)

    const countWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = await query(
      `SELECT COUNT(*) FROM bookings b LEFT JOIN users c ON c.id = b.customer_id LEFT JOIN users br ON br.id = b.barber_id ${countWhere}`,
      params.slice(0, -2)
    )
    res.json({ bookings: rows, total: parseInt(total.rows[0].count) })
  } catch (err) { next(err) }
})

router.patch('/bookings/:id/status', guard, async (req, res, next) => {
  try {
    const { status } = req.body
    const valid = ['requested','accepted','in_progress','completed','paid','declined','cancelled']
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' })
    await query(
      `UPDATE bookings SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, req.params.id]
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// Refund handler lives in routes/refunds.js (spec 0012). Mounted under
// /api/admin/bookings/:id/refund by app.js. Do not re-add here.

/* ─── Barbers ────────────────────────────────────────────── */
router.get('/barbers', guard, async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT u.id, u.name, u.email, u.is_suspended, u.created_at, u.stripe_account_id,
             b.rating_avg, b.rating_count, b.is_available,
             b.stripe_charges_enabled, b.stripe_payouts_enabled,
             b.bio, b.years_experience,
             (SELECT COUNT(*)::int FROM bookings WHERE barber_id = u.id AND status IN ('completed','paid')) AS completed_count,
             (SELECT COALESCE(SUM(price_cents),0)::bigint FROM bookings WHERE barber_id = u.id AND status IN ('completed','paid')) AS gmv_cents
      FROM barber_profiles b
      JOIN users u ON u.id = b.user_id
      ORDER BY b.rating_avg DESC NULLS LAST, completed_count DESC
    `)
    res.json({ barbers: rows })
  } catch (err) { next(err) }
})

/* ─── Reviews ────────────────────────────────────────────── */
router.get('/reviews', guard, async (req, res, next) => {
  try {
    const { barber_id, rating, limit = 50, offset = 0 } = req.query
    const params = []
    const conditions = []

    if (barber_id) { params.push(barber_id); conditions.push(`r.barber_id = $${params.length}`) }
    if (rating)    { params.push(parseInt(rating)); conditions.push(`r.rating = $${params.length}`) }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(parseInt(limit), parseInt(offset))

    const { rows } = await query(`
      SELECT r.id, r.rating, r.comment, r.created_at,
             reviewer.name AS reviewer_name, reviewer.email AS reviewer_email,
             barber.name   AS barber_name,
             b.service_type
      FROM reviews r
      JOIN users reviewer ON reviewer.id = r.reviewer_id
      JOIN users barber   ON barber.id   = r.barber_id
      LEFT JOIN bookings b ON b.id = r.booking_id
      ${where}
      ORDER BY r.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params)

    const total = await query(`SELECT COUNT(*) FROM reviews r ${where}`, params.slice(0, -2))
    res.json({ reviews: rows, total: parseInt(total.rows[0].count) })
  } catch (err) { next(err) }
})

router.delete('/reviews/:id', guard, async (req, res, next) => {
  try {
    const { rows } = await query(`DELETE FROM reviews WHERE id = $1 RETURNING barber_id`, [req.params.id])
    if (rows.length === 0) return res.status(404).json({ error: 'Review not found' })
    res.json({ ok: true })
  } catch (err) { next(err) }
})

/* ─── Activity log ───────────────────────────────────────── */
router.get('/activity', guard, async (req, res, next) => {
  try {
    const { limit = 50, offset = 0 } = req.query
    const { rows } = await query(`
      SELECT e.id, e.from_status, e.to_status, e.meta, e.created_at,
             actor.name  AS actor_name,  actor.role  AS actor_role,
             c.name      AS customer_name,
             br.name     AS barber_name,
             b.service_type, b.price_cents
      FROM booking_events e
      JOIN bookings b     ON b.id = e.booking_id
      LEFT JOIN users actor ON actor.id = e.actor_id
      LEFT JOIN users c     ON c.id = b.customer_id
      LEFT JOIN users br    ON br.id = b.barber_id
      ORDER BY e.created_at DESC
      LIMIT $1 OFFSET $2
    `, [parseInt(limit), parseInt(offset)])

    const total = await query(`SELECT COUNT(*) FROM booking_events`)
    res.json({ events: rows, total: parseInt(total.rows[0].count) })
  } catch (err) { next(err) }
})

/* ─── Platform Settings ──────────────────────────────────── */
router.get('/settings', guard, async (_req, res, next) => {
  try {
    const settings = await getSettings()
    res.json({ settings, defaults: SETTING_DEFAULTS })
  } catch (err) { next(err) }
})

router.patch('/settings', guard, async (req, res, next) => {
  try {
    const updates = req.body
    // Validate platform_fee_bps range if provided
    if (updates.platform_fee_bps !== undefined) {
      const bps = parseInt(updates.platform_fee_bps)
      if (isNaN(bps) || bps < 0 || bps > 5000) {
        return res.status(400).json({ error: 'platform_fee_bps must be 0–5000 (0–50%)' })
      }
    }
    await setSettings(updates)
    const settings = await getSettings()
    res.json({ ok: true, settings })
  } catch (err) { next(err) }
})

/* ─── Stripe webhook dead letter (spec 0011) ─────────────── */
// List failed events for admin inspection; trigger a manual retry on any one
// of them. The auto-retry job in services/queue.js handles attempts < 5; this
// is the escape hatch after that ceiling.
router.get('/webhooks', guard, async (req, res, next) => {
  try {
    const status = req.query.status || 'failed'
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200)
    const { rows } = await query(
      `SELECT id, type, status, attempts, last_error, received_at, processed_at
         FROM stripe_webhook_events
        WHERE status = $1
        ORDER BY received_at DESC
        LIMIT $2`,
      [status, limit]
    )
    res.json({ events: rows })
  } catch (err) { next(err) }
})

/* ─── Identity overrides (spec 0020) ─────────────────────── */
router.post('/barbers/:id/identity/override', guard, async (req, res, next) => {
  try {
    const notes = String(req.body?.notes || '').trim()
    if (notes.length < 5) return res.status(400).json({ error: 'notes_required' })
    const { rowCount } = await query(
      `UPDATE barber_profiles
          SET identity_status='verified', identity_verified_at=now(), identity_failure_reason=null
        WHERE user_id = $1`,
      [req.params.id]
    )
    if (!rowCount) return res.status(404).json({ error: 'barber_profile_not_found' })
    // Best-effort audit. (Adopting a real admin_audit_log table is part of a future spec.)
    console.log(`[admin override] identity verified for barber=${req.params.id} by admin=${req.user.id} notes="${notes}"`)
    res.json({ ok: true })
  } catch (err) { next(err) }
})

router.post('/barbers/:id/identity/retrigger', guard, async (req, res, next) => {
  try {
    await query(
      `UPDATE barber_profiles
          SET identity_status='unverified', identity_session_id=NULL, identity_failure_reason=NULL
        WHERE user_id = $1`,
      [req.params.id]
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

router.post('/webhooks/:id/retry', guard, async (req, res, next) => {
  try {
    // Reset attempts so the next reprocess gets a fresh budget even if we
    // were past the auto-retry ceiling.
    await query(
      `UPDATE stripe_webhook_events SET status='failed', attempts=0 WHERE id = $1`,
      [req.params.id]
    )
    const result = await reprocessEvent(req.params.id)
    if (!result.ok) {
      return res.status(400).json({ error: result.reason || result.error || 'reprocess_failed' })
    }
    res.json({ ok: true })
  } catch (err) { next(err) }
})

export default router
