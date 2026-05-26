import { Router } from 'express'
import { z } from 'zod'
import { query, getClient } from '../db/index.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { assertTransition } from '../middleware/booking-fsm.js'
import { sendNotification } from '../services/notifications.js'
import { scheduleAutoCancel, cancelAutoCancel } from '../services/queue.js'

const router = Router()

const CreateBookingSchema = z.object({
  barber_id:   z.string().uuid(),
  address:     z.string().min(5).max(500),
  lat:         z.number().optional(),
  lng:         z.number().optional(),
  scheduled_at:z.string().datetime(),
  service_type:z.string().min(1).max(100),
  price_cents: z.number().int().min(100),
  notes:       z.string().max(500).optional(),
})

/* POST /api/bookings */
router.post('/', requireAuth, requireRole('customer', 'facility'), async (req, res, next) => {
  try {
    const data = CreateBookingSchema.parse(req.body)

    const result = await query(
      `INSERT INTO bookings (customer_id, barber_id, address, lat, lng, scheduled_at, service_type, price_cents, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        req.user.id, data.barber_id, data.address, data.lat, data.lng,
        data.scheduled_at, data.service_type, data.price_cents, data.notes,
      ]
    )

    const booking = result.rows[0]

    // Notify barber
    await sendNotification(data.barber_id, {
      title: 'New cut request',
      body: `${data.service_type} at ${data.address}`,
      data: { booking_id: booking.id, type: 'new_request' },
    })

    // Auto-cancel after 10 min if no response
    await scheduleAutoCancel(booking.id, 10 * 60 * 1000)

    res.status(201).json({ booking })
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  }
})

/* GET /api/bookings/mine */
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const col = req.user.role === 'barber' ? 'barber_id' : 'customer_id'
    const result = await query(
      `SELECT b.*,
              cu.name AS customer_name, cu.phone AS customer_phone,
              bu.name AS barber_name
       FROM bookings b
       JOIN users cu ON cu.id = b.customer_id
       JOIN users bu ON bu.id = b.barber_id
       WHERE b.${col} = $1
       ORDER BY b.scheduled_at DESC`,
      [req.user.id]
    )
    res.json({ bookings: result.rows })
  } catch (err) {
    next(err)
  }
})

/* GET /api/bookings/:id */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT b.*, cu.name AS customer_name, bu.name AS barber_name
       FROM bookings b
       JOIN users cu ON cu.id = b.customer_id
       JOIN users bu ON bu.id = b.barber_id
       WHERE b.id = $1`,
      [req.params.id]
    )
    const booking = result.rows[0]
    if (!booking) return res.status(404).json({ error: 'Not found' })

    const allowed = [booking.customer_id, booking.barber_id]
    if (!allowed.includes(req.user.id)) return res.status(403).json({ error: 'Forbidden' })

    res.json({ booking })
  } catch (err) {
    next(err)
  }
})

/* PATCH /api/bookings/:id/accept */
router.patch('/:id/accept', requireAuth, requireRole('barber'), async (req, res, next) => {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [req.params.id])
    const booking = rows[0]
    if (!booking) return res.status(404).json({ error: 'Not found' })
    if (booking.barber_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' })
    if (!assertTransition(booking.status, 'accepted', res)) return

    // TODO: create Stripe PaymentIntent with capture_method: 'manual'
    await client.query(`UPDATE bookings SET status = 'accepted' WHERE id = $1`, [booking.id])
    await client.query('COMMIT')

    await cancelAutoCancel(booking.id)
    await sendNotification(booking.customer_id, {
      title: 'Barber confirmed',
      body: `Your barber is on the way. See you at ${new Date(booking.scheduled_at).toLocaleTimeString()}.`,
    })

    res.json({ ok: true, status: 'accepted' })
  } catch (err) {
    await client.query('ROLLBACK')
    next(err)
  } finally {
    client.release()
  }
})

/* PATCH /api/bookings/:id/decline */
router.patch('/:id/decline', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM bookings WHERE id = $1', [req.params.id])
    const booking = rows[0]
    if (!booking) return res.status(404).json({ error: 'Not found' })
    if (booking.barber_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' })
    if (!assertTransition(booking.status, 'declined', res)) return

    await query(`UPDATE bookings SET status = 'declined' WHERE id = $1`, [booking.id])
    await cancelAutoCancel(booking.id)
    await sendNotification(booking.customer_id, {
      title: 'Barber unavailable',
      body: 'Your barber declined. Try requesting another.',
    })

    res.json({ ok: true, status: 'declined' })
  } catch (err) {
    next(err)
  }
})

/* PATCH /api/bookings/:id/complete */
router.patch('/:id/complete', requireAuth, requireRole('barber'), async (req, res, next) => {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [req.params.id])
    const booking = rows[0]
    if (!booking) return res.status(404).json({ error: 'Not found' })
    if (booking.barber_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' })
    if (!assertTransition(booking.status, 'completed', res)) return

    await client.query(`UPDATE bookings SET status = 'completed' WHERE id = $1`, [booking.id])
    await client.query('COMMIT')

    // TODO: capture Stripe PaymentIntent + transfer 85% to barber

    await sendNotification(booking.customer_id, {
      title: 'Payment done',
      body: 'How was your cut? Leave a review.',
    })
    await sendNotification(booking.barber_id, {
      title: 'Payout sent',
      body: `$${((booking.price_cents * 0.85) / 100).toFixed(2)} on the way to your account.`,
    })

    res.json({ ok: true, status: 'completed' })
  } catch (err) {
    await client.query('ROLLBACK')
    next(err)
  } finally {
    client.release()
  }
})

/* PATCH /api/bookings/:id/cancel */
router.patch('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM bookings WHERE id = $1', [req.params.id])
    const booking = rows[0]
    if (!booking) return res.status(404).json({ error: 'Not found' })
    if (booking.customer_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' })
    if (!assertTransition(booking.status, 'cancelled', res)) return

    await query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [booking.id])
    await cancelAutoCancel(booking.id)

    res.json({ ok: true, status: 'cancelled' })
  } catch (err) {
    next(err)
  }
})

export default router
