import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/index.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = Router()

const ReviewSchema = z.object({
  booking_id: z.string().uuid(),
  rating:     z.number().int().min(1).max(5),
  comment:    z.string().max(1000).optional(),
})

/* GET /api/reviews/booking/:id — check if a review exists for this booking */
router.get('/booking/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT * FROM reviews WHERE booking_id = $1`,
      [req.params.id]
    )
    res.json({ review: rows[0] || null })
  } catch (err) { next(err) }
})

/* GET /api/reviews/barber/:id */
router.get('/barber/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT r.*, u.name AS reviewer_name
       FROM reviews r
       JOIN users u ON u.id = r.reviewer_id
       WHERE r.barber_id = $1
       ORDER BY r.created_at DESC
       LIMIT 50`,
      [req.params.id]
    )
    res.json({ reviews: rows })
  } catch (err) { next(err) }
})

/* POST /api/reviews */
router.post('/', requireAuth, requireRole('customer'), async (req, res, next) => {
  try {
    const data = ReviewSchema.parse(req.body)

    // Verify booking is completed and belongs to this customer
    const { rows } = await query(
      `SELECT * FROM bookings WHERE id = $1 AND customer_id = $2 AND status IN ('completed','paid')`,
      [data.booking_id, req.user.id]
    )
    const booking = rows[0]
    if (!booking) return res.status(403).json({ error: 'Booking not eligible for review' })

    const result = await query(
      `INSERT INTO reviews (booking_id, reviewer_id, barber_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (booking_id) DO UPDATE SET rating = $4, comment = $5
       RETURNING *`,
      [data.booking_id, req.user.id, booking.barber_id, data.rating, data.comment]
    )

    // Rating aggregates are also kept in sync by the trg_update_barber_rating
    // trigger (migration 003). This UPDATE is belt-and-braces for environments
    // where the trigger hasn't been applied yet — and is a no-op if it has.
    await query(
      `UPDATE barber_profiles SET
         rating_avg   = (SELECT AVG(rating)::numeric(3,2) FROM reviews WHERE barber_id = $1),
         rating_count = (SELECT COUNT(*)                  FROM reviews WHERE barber_id = $1)
       WHERE user_id = $1`,
      [booking.barber_id]
    )

    res.status(201).json({ review: result.rows[0] })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

export default router
