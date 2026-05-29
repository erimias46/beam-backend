// Two-way ratings: barber rates customer. See specs/0021-two-way-ratings.md.
//
// Mirror-image of routes/reviews.js but rated party + reviewer roles swapped
// and rating notes are private. Customers can never see their own breakdown
// or notes — only the aggregate (handled at the route level by what we return).

import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/index.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { idempotency } from '../middleware/idempotency.js'
import { getSetting } from '../services/settings.js'

const router = Router()

const CreateSchema = z.object({
  booking_id: z.string().uuid(),
  rating:     z.number().int().min(1).max(5),
  tags:       z.array(z.string().min(1).max(40)).max(10).optional(),
  notes:      z.string().max(1000).optional(),
})

/* POST /api/customer-ratings — barber rates the customer they served */
router.post('/', requireAuth, requireRole('barber'), idempotency(), async (req, res, next) => {
  try {
    const data = CreateSchema.parse(req.body)

    const { rows } = await query(
      `SELECT * FROM bookings WHERE id = $1 AND barber_id = $2 AND status IN ('completed','paid')`,
      [data.booking_id, req.user.id]
    )
    const booking = rows[0]
    if (!booking) return res.status(403).json({ error: 'booking_not_rateable' })

    const windowHours = parseInt(await getSetting('customer_rating_window_hours')) || 24
    const ageMs = Date.now() - new Date(booking.updated_at).getTime()
    if (ageMs > windowHours * 3_600_000) {
      return res.status(403).json({ error: 'rating_window_closed' })
    }

    try {
      const inserted = await query(
        `INSERT INTO customer_ratings (booking_id, barber_id, customer_id, rating, tags, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [data.booking_id, req.user.id, booking.customer_id, data.rating, data.tags ?? [], data.notes ?? null]
      )
      res.json({ rating: inserted.rows[0] })
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'already_rated' })
      }
      throw err
    }
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/* GET /api/customer-ratings/customer/:id — aggregate view (barbers + admin only) */
router.get('/customer/:id', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'barber' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden' })
    }
    const { rows } = await query(
      `SELECT customer_rating_avg AS avg, customer_rating_count AS count
         FROM users WHERE id = $1`,
      [req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'not_found' })
    // Tag frequencies — visible to barbers (signal) but no notes / reviewer.
    const tagAgg = await query(
      `SELECT tag, COUNT(*)::int AS n
         FROM customer_ratings, unnest(tags) AS tag
        WHERE customer_id = $1
        GROUP BY tag ORDER BY n DESC LIMIT 10`,
      [req.params.id]
    )
    res.json({
      avg:   rows[0].avg != null ? Number(rows[0].avg) : null,
      count: rows[0].count ?? 0,
      tags:  tagAgg.rows,
    })
  } catch (err) { next(err) }
})

/* GET /api/customer-ratings/me — customer's own aggregate (no breakdown) */
router.get('/me', requireAuth, requireRole('customer'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT customer_rating_avg AS avg, customer_rating_count AS count
         FROM users WHERE id = $1`,
      [req.user.id]
    )
    res.json({
      avg:   rows[0]?.avg != null ? Number(rows[0].avg) : null,
      count: rows[0]?.count ?? 0,
    })
  } catch (err) { next(err) }
})

/* GET /api/admin/customer-ratings/:id — full detail incl. notes + reviewer (admin only) */
router.get('/admin/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT cr.*, bu.name AS barber_name, b.scheduled_at, b.service_type
         FROM customer_ratings cr
         JOIN users b_users ON b_users.id = cr.customer_id
         JOIN users bu      ON bu.id      = cr.barber_id
         JOIN bookings b    ON b.id       = cr.booking_id
        WHERE cr.customer_id = $1
        ORDER BY cr.created_at DESC`,
      [req.params.id]
    )
    res.json({ ratings: rows })
  } catch (err) { next(err) }
})

export default router
