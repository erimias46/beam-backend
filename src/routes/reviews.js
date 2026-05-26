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

/* POST /api/reviews */
router.post('/', requireAuth, requireRole('customer', 'facility'), async (req, res, next) => {
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

    // Update barber rating avg
    await query(
      `UPDATE barber_profiles SET
         rating_avg   = (SELECT AVG(rating) FROM reviews WHERE barber_id = $1),
         rating_count = (SELECT COUNT(*) FROM reviews WHERE barber_id = $1)
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
