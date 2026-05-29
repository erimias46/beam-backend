// Barber favorites + re-book. See specs/0044-rebook-and-favorites.md.

import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/index.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { idempotency } from '../middleware/idempotency.js'
import { blockExistsBetween } from './reports.js'

const FavSchema = z.object({ barber_id: z.string().uuid() })
const RebookSchema = z.object({ scheduled_at: z.string().datetime() })

export const favoritesRouter = Router()

favoritesRouter.get('/', requireAuth, requireRole('customer'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT f.barber_id, f.created_at,
              u.name AS barber_name,
              bp.profile_photo_url, bp.rating_avg, bp.rating_count
         FROM barber_favorites f
         JOIN users u ON u.id = f.barber_id
         LEFT JOIN barber_profiles bp ON bp.user_id = u.id
        WHERE f.customer_id = $1
        ORDER BY f.created_at DESC`,
      [req.user.id]
    )
    res.json({ favorites: rows })
  } catch (err) { next(err) }
})

favoritesRouter.post('/', requireAuth, requireRole('customer'), async (req, res, next) => {
  try {
    const data = FavSchema.parse(req.body)
    if (data.barber_id === req.user.id) return res.status(400).json({ error: 'cannot_favorite_self' })
    await query(
      `INSERT INTO barber_favorites (customer_id, barber_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.user.id, data.barber_id]
    )
    res.json({ ok: true })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

favoritesRouter.delete('/:barberId', requireAuth, requireRole('customer'), async (req, res, next) => {
  try {
    await query(
      `DELETE FROM barber_favorites WHERE customer_id = $1 AND barber_id = $2`,
      [req.user.id, req.params.barberId]
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

/* Public barber favorites count (for the barber dashboard).
   We expose only the count — never identities. */
export const barberFavoritesCountRouter = Router()
barberFavoritesCountRouter.get('/me/favorites/count', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM barber_favorites WHERE barber_id = $1`,
      [req.user.id]
    )
    res.json({ count: rows[0]?.n ?? 0 })
  } catch (err) { next(err) }
})

/* POST /api/bookings/from/:past_booking_id — duplicate a prior booking.
   Mounted under /api/bookings in app.js so it composes with existing routes. */
export const rebookRouter = Router()
rebookRouter.post('/from/:past_booking_id', requireAuth, requireRole('customer'), idempotency(), async (req, res, next) => {
  try {
    const data = RebookSchema.parse(req.body)
    const { rows } = await query(`SELECT * FROM bookings WHERE id = $1`, [req.params.past_booking_id])
    const past = rows[0]
    if (!past) return res.status(404).json({ error: 'past_booking_not_found' })
    if (past.customer_id !== req.user.id) return res.status(403).json({ error: 'forbidden' })

    if (Date.parse(data.scheduled_at) <= Date.now() + 60_000) {
      return res.status(400).json({ error: 'scheduled_at_must_be_future' })
    }

    // Re-check same constraints as fresh booking: block, barber active.
    if (await blockExistsBetween(req.user.id, past.barber_id)) {
      return res.status(403).json({ error: 'block_relationship_exists' })
    }
    const barberCheck = await query(
      `SELECT u.id, u.is_suspended, bp.is_available
         FROM users u JOIN barber_profiles bp ON bp.user_id = u.id
        WHERE u.id = $1 AND u.role = 'barber'`,
      [past.barber_id]
    )
    const b = barberCheck.rows[0]
    if (!b) return res.status(404).json({ error: 'barber_not_found' })
    if (b.is_suspended || !b.is_available) return res.status(409).json({ error: 'barber_unavailable' })

    try {
      const inserted = await query(
        `INSERT INTO bookings (customer_id, barber_id, address, lat, lng, scheduled_at, service_type, price_cents, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [req.user.id, past.barber_id, past.address, past.lat, past.lng,
         data.scheduled_at, past.service_type, past.price_cents, past.notes]
      )
      res.status(201).json({ booking: inserted.rows[0] })
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'barber_already_booked_at_time' })
      throw err
    }
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})
