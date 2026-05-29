// Live barber location during an accepted booking — see specs/0031-live-barber-location-and-eta.md.
//
// Customer sees a real-time pin on the map + ETA. Barber sends location at
// ~10s cadence (we rate-limit to 1/5s server-side). Location auto-deletes on
// FSM transition to in_progress (barber arrived → start of service) and on
// any terminal status.

import { Router } from 'express'
import { z } from 'zod'
import { rateLimit } from 'express-rate-limit'
import { query } from '../db/index.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { emitToUsers } from '../services/sse.js'
import { getSetting } from '../services/settings.js'

const LOCATION_FRESH_MS = 60 * 1000  // older than 60s → null ETA

const PostSchema = z.object({
  lat:        z.number().min(-90).max(90),
  lng:        z.number().min(-180).max(180),
  heading:    z.number().int().min(0).max(359).optional(),
  accuracy_m: z.number().int().min(0).max(10000).optional(),
})

// 1 req per 5s per barber. The frontend should sample, not spam.
const locationLimiter = rateLimit({
  windowMs: 5 * 1000,
  max: 1,
  keyGenerator: (req) => `${req.user?.id}:${req.params.id}`,
  standardHeaders: true, legacyHeaders: false,
})

export const locationRouter = Router({ mergeParams: true })

/** Haversine distance in km between two (lat,lng) points. */
function distanceKm(a, b) {
  const R = 6371
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const lat1 = a.lat * Math.PI / 180
  const lat2 = b.lat * Math.PI / 180
  const h = Math.sin(dLat/2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng/2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/* POST /api/bookings/:id/location — barber pushes their current position */
locationRouter.post('/:id/location', requireAuth, requireRole('barber'), locationLimiter, async (req, res, next) => {
  try {
    const data = PostSchema.parse(req.body)
    const { rows } = await query(
      `SELECT id, customer_id, barber_id, status, lat AS cust_lat, lng AS cust_lng
         FROM bookings WHERE id = $1`,
      [req.params.id]
    )
    const booking = rows[0]
    if (!booking) return res.status(404).json({ error: 'booking_not_found' })
    if (booking.barber_id !== req.user.id) return res.status(403).json({ error: 'forbidden' })
    if (!['accepted', 'in_progress'].includes(booking.status)) {
      return res.status(409).json({ error: 'booking_not_active', status: booking.status })
    }

    await query(
      `INSERT INTO barber_location_live (barber_id, booking_id, lat, lng, heading, accuracy_m, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (barber_id) DO UPDATE
         SET booking_id = EXCLUDED.booking_id,
             lat        = EXCLUDED.lat,
             lng        = EXCLUDED.lng,
             heading    = EXCLUDED.heading,
             accuracy_m = EXCLUDED.accuracy_m,
             updated_at = now()`,
      [req.user.id, booking.id, data.lat, data.lng, data.heading ?? null, data.accuracy_m ?? null]
    )

    // ETA snapshot — straight-line distance × configured avg speed.
    const avgKmh = parseFloat(await getSetting('eta_avg_kmh')) || 40
    let etaSeconds = null
    if (booking.cust_lat != null && booking.cust_lng != null) {
      const km = distanceKm({ lat: data.lat, lng: data.lng }, { lat: Number(booking.cust_lat), lng: Number(booking.cust_lng) })
      etaSeconds = Math.round((km / avgKmh) * 3600)
    }

    emitToUsers([booking.customer_id], 'barber_location', {
      booking_id: booking.id,
      lat: data.lat, lng: data.lng,
      heading: data.heading ?? null,
      eta_seconds: etaSeconds,
    })
    res.json({ ok: true, eta_seconds: etaSeconds })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/* GET /api/bookings/:id/location — read latest position + ETA. Customer or barber. */
locationRouter.get('/:id/location', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT b.customer_id, b.barber_id, b.lat AS cust_lat, b.lng AS cust_lng,
              l.lat, l.lng, l.heading, l.updated_at
         FROM bookings b
         LEFT JOIN barber_location_live l ON l.booking_id = b.id
        WHERE b.id = $1`,
      [req.params.id]
    )
    const row = rows[0]
    if (!row) return res.status(404).json({ error: 'booking_not_found' })
    if (req.user.role !== 'admin'
        && row.customer_id !== req.user.id
        && row.barber_id   !== req.user.id) {
      return res.status(403).json({ error: 'forbidden' })
    }

    if (row.lat == null) {
      return res.json({ lat: null, lng: null, heading: null, updated_at: null, eta_seconds: null })
    }

    const ageMs = Date.now() - new Date(row.updated_at).getTime()
    if (ageMs > LOCATION_FRESH_MS) {
      return res.json({
        lat: Number(row.lat), lng: Number(row.lng), heading: row.heading,
        updated_at: row.updated_at, eta_seconds: null, stale: true,
      })
    }
    const avgKmh = parseFloat(await getSetting('eta_avg_kmh')) || 40
    let etaSeconds = null
    if (row.cust_lat != null && row.cust_lng != null) {
      const km = distanceKm(
        { lat: Number(row.lat),       lng: Number(row.lng) },
        { lat: Number(row.cust_lat),  lng: Number(row.cust_lng) },
      )
      etaSeconds = Math.round((km / avgKmh) * 3600)
    }
    res.json({
      lat: Number(row.lat), lng: Number(row.lng), heading: row.heading,
      updated_at: row.updated_at, eta_seconds: etaSeconds,
    })
  } catch (err) { next(err) }
})

/* DELETE /api/bookings/:id/location — explicit stop (e.g. barber tap "Arrived"). */
locationRouter.delete('/:id/location', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT barber_id FROM bookings WHERE id = $1`, [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'booking_not_found' })
    if (rows[0].barber_id !== req.user.id) return res.status(403).json({ error: 'forbidden' })
    await query(`DELETE FROM barber_location_live WHERE booking_id = $1`, [req.params.id])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

/** Used by booking-fsm to wipe the row when status leaves the active window. */
export async function clearLocationForBooking(bookingId) {
  await query(`DELETE FROM barber_location_live WHERE booking_id = $1`, [bookingId])
    .catch(() => {})
}
