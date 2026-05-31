// Barber operations — Phase 5.
// 0050 heartbeat/ping
// 0051 weekly schedule + vacation
// 0052 earnings CSV export + Stripe Express link + payouts
// 0053 service-area polygon

import { Router } from 'express'
import { z } from 'zod'
import Stripe from 'stripe'
import { query, getClient } from '../db/index.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null

const router = Router()

/* ─── 0050 Heartbeat ─────────────────────────────────────── */
router.post('/me/ping', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    await query(
      `INSERT INTO barber_profiles (user_id, last_online_ping_at)
       VALUES ($1, now())
       ON CONFLICT (user_id) DO UPDATE SET last_online_ping_at = now()`,
      [req.user.id]
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

/* ─── 0051 Weekly schedule + vacation ────────────────────── */
const WindowSchema = z.object({
  day_of_week:  z.number().int().min(0).max(6),
  start_minute: z.number().int().min(0).max(1439),
  end_minute:   z.number().int().min(1).max(1440),
})
const PutScheduleSchema = z.object({
  timezone: z.string().min(2).max(64).optional(),
  windows:  z.array(WindowSchema).max(50),
})

router.get('/me/schedule', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const tz = await query(`SELECT timezone, vacation_until FROM barber_profiles WHERE user_id = $1`, [req.user.id])
    const win = await query(
      `SELECT day_of_week, start_minute, end_minute FROM barber_weekly_schedule
        WHERE barber_id = $1 ORDER BY day_of_week, start_minute`,
      [req.user.id]
    )
    res.json({
      timezone:       tz.rows[0]?.timezone || 'America/New_York',
      vacation_until: tz.rows[0]?.vacation_until || null,
      windows:        win.rows,
    })
  } catch (err) { next(err) }
})

router.put('/me/schedule', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const data = PutScheduleSchema.parse(req.body)
    for (const w of data.windows) {
      if (w.end_minute <= w.start_minute) {
        return res.status(400).json({ error: 'invalid_window', message: 'end_minute must exceed start_minute' })
      }
    }
    const client = await getClient()
    try {
      await client.query('BEGIN')
      if (data.timezone) {
        await client.query(`UPDATE barber_profiles SET timezone = $2 WHERE user_id = $1`, [req.user.id, data.timezone])
      }
      await client.query(`DELETE FROM barber_weekly_schedule WHERE barber_id = $1`, [req.user.id])
      for (const w of data.windows) {
        await client.query(
          `INSERT INTO barber_weekly_schedule (barber_id, day_of_week, start_minute, end_minute)
           VALUES ($1, $2, $3, $4)`,
          [req.user.id, w.day_of_week, w.start_minute, w.end_minute]
        )
      }
      await client.query('COMMIT')
      res.json({ ok: true })
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err }
    finally { client.release() }
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

router.patch('/me/vacation', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const until = req.body?.vacation_until ?? req.body?.until ?? undefined
    if (until !== null && until !== undefined && (typeof until !== 'string' || isNaN(Date.parse(until)))) {
      return res.status(400).json({ error: 'invalid_until' })
    }
    await query(
      `UPDATE barber_profiles SET vacation_until = $2 WHERE user_id = $1`,
      [req.user.id, until ? new Date(until).toISOString() : null]
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

/* Public read of a barber's schedule (for booking flow). */
router.get('/:id/schedule', async (req, res, next) => {
  try {
    const tz = await query(`SELECT timezone, vacation_until FROM barber_profiles WHERE user_id = $1`, [req.params.id])
    const win = await query(
      `SELECT day_of_week, start_minute, end_minute FROM barber_weekly_schedule
        WHERE barber_id = $1 ORDER BY day_of_week, start_minute`,
      [req.params.id]
    )
    res.json({
      timezone:       tz.rows[0]?.timezone || 'America/New_York',
      vacation_until: tz.rows[0]?.vacation_until || null,
      windows:        win.rows,
    })
  } catch (err) { next(err) }
})

/* ─── 0052 Earnings export + Stripe Express link + payouts ── */

router.get('/me/earnings/export', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 90 * 86400_000)
    const to   = req.query.to   ? new Date(req.query.to)   : new Date()
    if (isNaN(from) || isNaN(to)) return res.status(400).json({ error: 'invalid_date_range' })

    const { rows } = await query(
      `SELECT b.created_at::date AS day, b.id, b.service_type,
              b.price_cents, b.tip_cents, b.refunded_cents,
              cu.name AS customer_name
         FROM bookings b
         JOIN users cu ON cu.id = b.customer_id
        WHERE b.barber_id = $1
          AND b.status IN ('completed','paid')
          AND b.created_at >= $2
          AND b.created_at <  $3
        ORDER BY b.created_at ASC`,
      [req.user.id, from, to]
    )

    const headers = ['date','booking_id','customer_name','service','price_cents','tip_cents','platform_fee_cents','net_cents','refund_cents']
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS || '1500')
    const lines = [headers.join(',')]
    for (const r of rows) {
      const fee = Math.round(r.price_cents * FEE_BPS / 10_000)
      const net = (r.price_cents - fee) + (r.tip_cents || 0) - (r.refunded_cents || 0)
      lines.push([
        r.day, r.id, esc(r.customer_name), esc(r.service_type),
        r.price_cents, r.tip_cents || 0, fee, net, r.refunded_cents || 0,
      ].join(','))
    }
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="earnings_${from.toISOString().slice(0,10)}_to_${to.toISOString().slice(0,10)}.csv"`)
    res.send(lines.join('\n') + '\n')
  } catch (err) { next(err) }
})

router.get('/me/stripe-express-link', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' })
    const { rows } = await query(`SELECT stripe_account_id FROM users WHERE id = $1`, [req.user.id])
    const acct = rows[0]?.stripe_account_id
    if (!acct) return res.status(409).json({ error: 'no_connect_account' })
    const link = await stripe.accounts.createLoginLink(acct)
    res.json({ url: link.url })
  } catch (err) { next(err) }
})

router.get('/me/payouts', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const { rows } = await query(
      `SELECT * FROM barber_payouts WHERE barber_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [req.user.id, limit]
    )
    res.json({ payouts: rows })
  } catch (err) { next(err) }
})

/* ─── 0053 Service-area polygon ──────────────────────────── */
const PolygonSchema = z.object({
  polygon:   z.array(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })).min(3).max(50).nullable(),
  radius_km: z.number().min(0.5).max(500).optional(),
})

router.patch('/me/service-area', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const data = PolygonSchema.parse(req.body)
    const sets = []
    const params = [req.user.id]
    if (data.polygon === null) {
      params.push(null); sets.push(`service_polygon = $${params.length}`)
    } else if (data.polygon) {
      params.push(JSON.stringify(data.polygon)); sets.push(`service_polygon = $${params.length}::jsonb`)
    }
    if (data.radius_km != null) {
      params.push(data.radius_km); sets.push(`service_radius_km = $${params.length}`)
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' })
    await query(
      `UPDATE barber_profiles SET ${sets.join(', ')} WHERE user_id = $1`,
      params
    )
    res.json({ ok: true })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/** Pure-JS point-in-polygon (ray casting). Used by routes/bookings.js too. */
export function pointInPolygon(point, polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng, yi = polygon[i].lat
    const xj = polygon[j].lng, yj = polygon[j].lat
    const intersect = ((yi > point.lat) !== (yj > point.lat))
      && (point.lng < (xj - xi) * (point.lat - yi) / (yj - yi) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

export default router
