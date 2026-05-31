import { Router } from 'express'
import { z } from 'zod'
import Stripe from 'stripe'
import jwt from 'jsonwebtoken'
import multer from 'multer'
import path from 'path'
import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { Redis } from 'ioredis'
import { query, getClient } from '../db/index.js'
import { requireAuth, requireRole, JWT_SECRET } from '../middleware/auth.js'
import { assertTransition } from '../middleware/booking-fsm.js'
import { idempotency } from '../middleware/idempotency.js'
import { getCancellationFee } from '../services/cancellation-policy.js'
import { blockExistsBetween } from './reports.js'
import { clearLocationForBooking } from './location.js'
import { pointInPolygon } from './barber-ops.js'
import { redeemPromoIfValid, redeemPromoWithClient, checkPromo } from './promos.js'
import { scheduleBarberNoShowCheck, cancelBarberNoShowCheck, scheduleAutoConfirm, cancelAutoConfirm } from '../services/queue.js'
import { sendNotification } from '../services/notifications.js'
import { scheduleAutoCancel, cancelAutoCancel, scheduleAutoComplete, cancelAutoComplete } from '../services/queue.js'
import { addClient, removeClient, emitToUsers } from '../services/sse.js'
import { getPlatformFeeBps, getBarberShare } from '../config.js'

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true })

// Completion photo upload (spec 0023). Same disk-based pattern as barber
// profile photos. 5 MB cap, JPG/PNG/WebP only.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const COMPLETION_UPLOADS_DIR = path.join(__dirname, '../../uploads/completions')
mkdirSync(COMPLETION_UPLOADS_DIR, { recursive: true })
const completionUpload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, COMPLETION_UPLOADS_DIR),
    filename: (_, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg'
      cb(null, `${randomUUID()}${ext}`)
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp']
    cb(allowed.includes(file.mimetype) ? null : new Error('Only JPG, PNG and WebP'), allowed.includes(file.mimetype))
  },
})
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null

const router = Router()

const CreateBookingSchema = z.object({
  barber_id:    z.string().uuid(),
  address:      z.string().min(5).max(500),
  lat:          z.number().min(-90).max(90).optional(),
  lng:          z.number().min(-180).max(180).optional(),
  scheduled_at: z.string().datetime(),
  service_type: z.string().min(1).max(100),
  price_cents:  z.number().int().min(500).max(100_000),
  notes:        z.string().max(500).optional(),
  payment_method_id: z.string().optional(), // Stripe pm_… from frontend
  promo_code:        z.string().min(2).max(40).optional(),  // spec 0070
})

async function logEvent(client, bookingId, actorId, from, to, meta) {
  try {
    await (client || { query }).query(
      `INSERT INTO booking_events (booking_id, actor_id, from_status, to_status, meta)
       VALUES ($1, $2, $3, $4, $5)`,
      [bookingId, actorId, from, to, meta ? JSON.stringify(meta) : null]
    )
  } catch (err) {
    // booking_events is best-effort audit; never fail the request because of it
    console.warn('[booking_events]', err.message)
  }
}

/* POST /api/bookings/sse-ticket — issue a single-use 60s SSE nonce (spec 0087) */
router.post('/sse-ticket', requireAuth, async (req, res, next) => {
  try {
    const { randomBytes } = await import('crypto')
    const nonce = randomBytes(32).toString('hex')
    // Store in Redis with 60s TTL, value = user ID
    const redisKey = `sse:${nonce}`
    await redis.setex(redisKey, 60, req.user.id)
    res.json({ ticket: nonce })
  } catch (err) { next(err) }
})

/* GET /api/bookings/events  — Server-Sent Events stream for real-time status pushes */
router.get('/events', async (req, res) => {
  let userId

  // Spec 0087: prefer single-use ticket over raw JWT in query string
  const ticketParam = req.query.ticket
  if (ticketParam && ticketParam.length === 64) {
    const storedUserId = await redis.getdel(`sse:${ticketParam}`)
    if (!storedUserId) return res.status(401).end()
    userId = storedUserId
  } else {
    // EventSource can't set headers; accept token via query param as fallback
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token
    if (!token) return res.status(401).end()
    try {
      const payload = jwt.verify(token, JWT_SECRET)
      userId = payload.sub || payload.id
    } catch {
      return res.status(401).end()
    }
  }

  res.setHeader('Content-Type',  'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection',    'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // nginx: disable proxy buffering
  res.flushHeaders()

  res.write(`: connected\n\n`) // initial comment keeps connection alive in some browsers
  addClient(userId, res)

  const keepAlive = setInterval(() => {
    try { res.write(`: ping\n\n`) } catch { clearInterval(keepAlive) }
  }, 25_000)

  req.on('close', () => {
    clearInterval(keepAlive)
    removeClient(userId, res)
  })
})

/* POST /api/bookings */
router.post('/', requireAuth, requireRole('customer', 'facility'), idempotency(), async (req, res, next) => {
  try {
    const data = CreateBookingSchema.parse(req.body)

    if (data.barber_id === req.user.id) {
      return res.status(400).json({ error: 'You cannot book yourself' })
    }

    // Spec 0022: reject bookings between users who have a block relationship.
    if (await blockExistsBetween(req.user.id, data.barber_id)) {
      return res.status(403).json({
        error: 'block_relationship_exists',
        message: 'Booking unavailable between these users.',
      })
    }

    // scheduled_at must be in the future
    if (Date.parse(data.scheduled_at) <= Date.now() + 60_000) {
      return res.status(400).json({ error: 'scheduled_at must be at least 1 minute in the future' })
    }

    // Verify the barber exists, has role=barber, is not suspended, and is available
    const barberCheck = await query(
      `SELECT u.id, u.is_suspended, bp.is_available,
              bp.service_polygon, bp.timezone, bp.vacation_until
         FROM users u
         JOIN barber_profiles bp ON bp.user_id = u.id
        WHERE u.id = $1 AND u.role = 'barber'`,
      [data.barber_id]
    )
    const barber = barberCheck.rows[0]
    if (!barber) return res.status(404).json({ error: 'Barber not found' })
    if (barber.is_suspended) return res.status(409).json({ error: 'Barber unavailable' })
    if (!barber.is_available) return res.status(409).json({ error: 'Barber is not taking requests' })

    // Spec 0051: refuse bookings during the barber's vacation.
    const scheduledAt = new Date(data.scheduled_at)
    if (barber.vacation_until && scheduledAt < new Date(barber.vacation_until)) {
      return res.status(409).json({ error: 'barber_on_vacation' })
    }

    // Spec 0051: refuse bookings outside the barber's weekly schedule. We use
    // their stored timezone to compute day-of-week / minute-of-day.
    const wsched = await query(
      `SELECT day_of_week, start_minute, end_minute FROM barber_weekly_schedule WHERE barber_id = $1`,
      [data.barber_id]
    )
    if (wsched.rows.length) {
      // Convert scheduledAt into the barber's local time.
      const tz = barber.timezone || 'America/New_York'
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
      const parts = fmt.formatToParts(scheduledAt)
      const dayName = parts.find(p => p.type === 'weekday')?.value || 'Mon'
      const hour    = parseInt(parts.find(p => p.type === 'hour')?.value || '0')
      const minute  = parseInt(parts.find(p => p.type === 'minute')?.value || '0')
      const dowMap  = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 }
      const dow = dowMap[dayName] ?? 1
      const minOfDay = hour * 60 + minute
      const ok = wsched.rows.some(w =>
        w.day_of_week === dow && minOfDay >= w.start_minute && minOfDay < w.end_minute
      )
      if (!ok) return res.status(409).json({ error: 'outside_barber_hours' })
    }

    // Spec 0053: if a service polygon is set, refuse out-of-zone customer pins.
    if (barber.service_polygon && data.lat != null && data.lng != null) {
      try {
        const poly = Array.isArray(barber.service_polygon) ? barber.service_polygon : JSON.parse(barber.service_polygon)
        if (!pointInPolygon({ lat: data.lat, lng: data.lng }, poly)) {
          return res.status(409).json({ error: 'outside_service_area' })
        }
      } catch { /* malformed polygon — fall through */ }
    }

    let booking
    const bookingClient = await getClient()
    try {
      await bookingClient.query('BEGIN')

      let insertResult
      try {
        insertResult = await bookingClient.query(
          `INSERT INTO bookings (customer_id, barber_id, address, lat, lng, scheduled_at, service_type, price_cents, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [
            req.user.id, data.barber_id, data.address, data.lat, data.lng,
            data.scheduled_at, data.service_type, data.price_cents, data.notes,
          ]
        )
      } catch (err) {
        await bookingClient.query('ROLLBACK').catch(() => {})
        bookingClient.release()
        // bookings_barber_active_slot_idx — barber already has an active booking at this time
        if (err.code === '23505') {
          return res.status(409).json({ error: 'Barber already booked at this time' })
        }
        throw err
      }
      booking = insertResult.rows[0]

      // Spec 0070 / MONEY-9: redeem promo inside the booking insert transaction
      // so the redemption and booking row are committed atomically.
      if (data.promo_code) {
        const promoCheck = await checkPromo(data.promo_code, req.user.id, data.price_cents)
        const discount = promoCheck.applies
          ? await redeemPromoWithClient(bookingClient, promoCheck, req.user.id, booking.id)
          : 0
        if (discount > 0) {
          await bookingClient.query(
            `UPDATE bookings SET promo_code = $2, promo_discount_cents = $3 WHERE id = $1`,
            [booking.id, data.promo_code.toUpperCase(), discount]
          )
          booking.promo_code           = data.promo_code.toUpperCase()
          booking.promo_discount_cents = discount
        }
      }

      await bookingClient.query('COMMIT')
    } catch (err) {
      await bookingClient.query('ROLLBACK').catch(() => {})
      bookingClient.release()
      throw err
    }
    bookingClient.release()

    await logEvent(null, booking.id, req.user.id, null, 'requested', null)

    emitToUsers([data.barber_id, req.user.id], 'booking_updated', { booking_id: booking.id, status: 'requested' })

    sendNotification(data.barber_id, {
      title: 'New cut request',
      body:  `${data.service_type} at ${data.address}`,
      data:  { booking_id: booking.id, type: 'new_request' },
    }).catch(err => console.warn('[notify]', err.message))

    scheduleAutoCancel(booking.id, 10 * 60 * 1000)
      .catch(err => console.warn('[queue]', err.message))

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
    const { rows } = await query(
      `SELECT b.*,
              cu.name AS customer_name, cu.phone AS customer_phone,
              bu.name AS barber_name
         FROM bookings b
         JOIN users cu ON cu.id = b.customer_id
         JOIN users bu ON bu.id = b.barber_id
        WHERE b.${col} = $1
        ORDER BY b.scheduled_at DESC
        LIMIT 200`,
      [req.user.id]
    )
    res.json({ bookings: rows })
  } catch (err) { next(err) }
})

/* GET /api/bookings/:id */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT b.*, cu.name AS customer_name, bu.name AS barber_name
         FROM bookings b
         JOIN users cu ON cu.id = b.customer_id
         JOIN users bu ON bu.id = b.barber_id
        WHERE b.id = $1`,
      [req.params.id]
    )
    const booking = rows[0]
    if (!booking) return res.status(404).json({ error: 'Not found' })

    if (req.user.role !== 'admin' &&
        booking.customer_id !== req.user.id &&
        booking.barber_id   !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    res.json({ booking })
  } catch (err) { next(err) }
})

/* PATCH /api/bookings/:id/accept */
router.patch('/:id/accept', requireAuth, requireRole('barber'), idempotency(), async (req, res, next) => {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      'SELECT * FROM bookings WHERE id = $1 FOR UPDATE',
      [req.params.id]
    )
    const booking = rows[0]
    if (!booking) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Not found' })
    }
    if (booking.barber_id !== req.user.id) {
      await client.query('ROLLBACK')
      return res.status(403).json({ error: 'Forbidden' })
    }
    if (!canTransitionOrReject(client, res, booking.status, 'accepted')) return

    // Spec 0022: block check at accept time too (in case it was added after request).
    if (await blockExistsBetween(booking.customer_id, booking.barber_id)) {
      await client.query('ROLLBACK')
      return res.status(403).json({
        error: 'block_relationship_exists',
        message: 'Booking unavailable between these users.',
      })
    }

    // Look up the barber's Stripe Connect account + onboarding state.
    // Barbers can go online without Stripe, but accepting a booking authorizes
    // a charge against their connected account, so it requires *completed*
    // onboarding (charges enabled) — not just a created account.
    const barberInfo = await client.query(
      `SELECT u.stripe_account_id,
              COALESCE(bp.stripe_charges_enabled, false) AS charges_enabled,
              COALESCE(bp.identity_status, 'unverified')  AS identity_status
         FROM users u
         LEFT JOIN barber_profiles bp ON bp.user_id = u.id
        WHERE u.id = $1`,
      [booking.barber_id]
    )
    const barberStripeId = barberInfo.rows[0]?.stripe_account_id
    const chargesEnabled = barberInfo.rows[0]?.charges_enabled === true
    const identityStatus = barberInfo.rows[0]?.identity_status

    if (stripe && (!barberStripeId || !chargesEnabled)) {
      await client.query('ROLLBACK')
      return res.status(409).json({
        error: 'Connect Stripe and finish onboarding before accepting bookings.',
        code: 'stripe_onboarding_incomplete',
      })
    }

    // Identity gate (spec 0020). Feature-flag controlled — defaults on. Barbers
    // must verify before accepting their first booking.
    const { getSetting } = await import('../services/settings.js')
    if ((await getSetting('identity_required_for_accept')) === 'true'
        && identityStatus !== 'verified') {
      await client.query('ROLLBACK')
      return res.status(403).json({
        error: 'identity_not_verified',
        message: 'Verify your identity to start accepting bookings.',
        code: 'identity_not_verified',
        identity_status: identityStatus,
      })
    }

    // Destination charge: platform charges the customer, Stripe automatically transfers
    // (amount - application_fee_amount) to the barber's connected account.
    let paymentIntentId = booking.stripe_payment_intent_id
    if (stripe && !paymentIntentId) {
      // Spec 0070: PI charges net-of-promo-discount. App fee is computed on
      // the discounted total so the platform isn't subsidizing the promo.
      const chargeable = Math.max(0, booking.price_cents - (booking.promo_discount_cents || 0))
      if (chargeable === 0) {
        // Free booking. Skip PI entirely; transition straight to accepted.
        await client.query(`UPDATE bookings SET status = 'accepted' WHERE id = $1`, [booking.id])
        await logEvent(client, booking.id, req.user.id, booking.status, 'accepted', { free: true })
        await client.query('COMMIT')
        return res.json({ ok: true, status: 'accepted', free: true })
      }
      const appFee = Math.round(chargeable * (await getPlatformFeeBps()) / 10_000)

      // Resolve the customer's saved payment method.
      // Priority (spec 0041 updated): 1) explicit pm_ id, 2) user's saved default,
      // 3) most-recent PM on their Stripe customer.
      let pmId = req.body?.payment_method_id ?? null
      let customerId = null

      const custRow = await client.query(
        'SELECT stripe_customer_id, default_payment_method_id FROM users WHERE id = $1',
        [booking.customer_id]
      )
      customerId = custRow.rows[0]?.stripe_customer_id ?? null
      const customerDefault = custRow.rows[0]?.default_payment_method_id ?? null

      if (!pmId && customerDefault) pmId = customerDefault
      if (!pmId && customerId) {
        const pms = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 })
        pmId = pms.data[0]?.id ?? null
      }

      if (!pmId) {
        await client.query('ROLLBACK')
        return res.status(409).json({
          error: 'Customer has no saved payment method. They must add a card before a booking can be confirmed.',
          code: 'no_payment_method',
        })
      }

      const piParams = {
        amount: chargeable,
        currency: 'usd',
        capture_method: 'manual',
        payment_method: pmId,
        confirm: true,
        off_session: true,
        application_fee_amount: appFee,
        transfer_data: { destination: barberStripeId },
        metadata: { booking_id: booking.id, barber_id: req.user.id, customer_id: booking.customer_id },
      }
      if (customerId) piParams.customer = customerId

      // Deterministic idempotency key: a retry of /accept on the same booking
      // must not create a second PaymentIntent. See specs/0010.
      const pi = await stripe.paymentIntents.create(piParams, {
        idempotencyKey: `booking_accept_${booking.id}`,
      })
      paymentIntentId = pi.id

      // If PI requires action (3DS), we can't proceed — notify customer and leave as requested
      if (pi.status === 'requires_action') {
        await client.query('ROLLBACK')
        sendNotification(booking.customer_id, {
          title: 'Action required',
          body: 'Your bank requires additional verification to confirm this booking.',
          data: { booking_id: booking.id, type: 'requires_action', client_secret: pi.client_secret },
        }).catch(() => {})
        return res.status(402).json({
          error: 'Payment requires customer action (3DS)',
          client_secret: pi.client_secret,
          code: 'requires_action',
        })
      }

      await client.query(
        'UPDATE bookings SET stripe_payment_intent_id = $1, service_payment_method_id = $2 WHERE id = $3',
        [paymentIntentId, pmId, booking.id]
      )
    }

    await client.query(`UPDATE bookings SET status = 'accepted' WHERE id = $1`, [booking.id])
    await logEvent(client, booking.id, req.user.id, booking.status, 'accepted', { pi: paymentIntentId })
    await client.query('COMMIT')

    cancelAutoCancel(booking.id).catch(e => console.warn('[queue]', e.message))
    // Spec 0013: schedule barber-no-show watchdog at scheduled_at + 15min (configurable).
    try {
      const { getSetting } = await import('../services/settings.js')
      const deadlineMin = parseInt(await getSetting('barber_no_show_deadline_minutes')) || 15
      const fireAt = new Date(booking.scheduled_at).getTime() + deadlineMin * 60_000
      scheduleBarberNoShowCheck(booking.id, fireAt).catch(() => {})
    } catch (err) {
      console.warn('[no-show schedule]', err.message)
    }
    emitToUsers([booking.customer_id, req.user.id], 'booking_updated', { booking_id: booking.id, status: 'accepted' })
    sendNotification(booking.customer_id, {
      title: 'Barber confirmed',
      body:  `Your barber is on the way. See you at ${new Date(booking.scheduled_at).toLocaleString()}.`,
      data:  { booking_id: booking.id, type: 'accepted' },
    }).catch(e => console.warn('[notify]', e.message))

    res.json({ ok: true, status: 'accepted', payment_intent_id: paymentIntentId })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    next(err)
  } finally {
    client.release()
  }
})

/* PATCH /api/bookings/:id/decline */
router.patch('/:id/decline', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const { rows: preRows } = await query('SELECT status, barber_id, customer_id FROM bookings WHERE id = $1', [req.params.id])
    const pre = preRows[0]
    if (!pre) return res.status(404).json({ error: 'Not found' })
    if (pre.barber_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' })
    if (!assertTransition(pre.status, 'declined', res)) return

    // Atomic conditional update — prevents concurrent double-transition
    const { rows, rowCount } = await query(
      `UPDATE bookings SET status = 'declined' WHERE id = $1 AND status = $2 RETURNING *`,
      [req.params.id, pre.status]
    )
    if (!rowCount) return res.status(409).json({ error: 'booking_state_changed', message: 'Booking status changed — please refresh.' })
    const booking = rows[0]
    await logEvent(null, booking.id, req.user.id, pre.status, 'declined', null)
    cancelAutoCancel(booking.id).catch(e => console.warn('[queue]', e.message))
    emitToUsers([booking.customer_id, req.user.id], 'booking_updated', { booking_id: booking.id, status: 'declined' })
    sendNotification(booking.customer_id, {
      title: 'Barber unavailable',
      body:  'Your barber declined. Try requesting another.',
      data:  { booking_id: booking.id, type: 'declined' },
    }).catch(e => console.warn('[notify]', e.message))

    res.json({ ok: true, status: 'declined' })
  } catch (err) { next(err) }
})

/* PATCH /api/bookings/:id/start  — accepted → in_progress */
router.patch('/:id/start', requireAuth, requireRole('barber'), async (req, res, next) => {
  try {
    const { rows: preRows } = await query('SELECT status, barber_id, customer_id FROM bookings WHERE id = $1', [req.params.id])
    const pre = preRows[0]
    if (!pre) return res.status(404).json({ error: 'Not found' })
    if (pre.barber_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' })
    if (!assertTransition(pre.status, 'in_progress', res)) return

    // Atomic conditional update — prevents concurrent double-transition
    const { rows, rowCount } = await query(
      `UPDATE bookings SET status = 'in_progress' WHERE id = $1 AND status = $2 RETURNING *`,
      [req.params.id, pre.status]
    )
    if (!rowCount) return res.status(409).json({ error: 'booking_state_changed', message: 'Booking status changed — please refresh.' })
    const booking = rows[0]
    await logEvent(null, booking.id, req.user.id, pre.status, 'in_progress', null)

    emitToUsers([booking.customer_id, req.user.id], 'booking_updated', { booking_id: booking.id, status: 'in_progress' })
    cancelBarberNoShowCheck(booking.id).catch(() => {})
    // Spec 0031: stop sharing barber location once service starts.
    clearLocationForBooking(booking.id).catch(() => {})
    scheduleAutoComplete(booking.id, 4 * 60 * 60 * 1000).catch(e => console.warn('[queue]', e.message))
    sendNotification(booking.customer_id, {
      title: 'Service started',
      body:  'Your barber has begun. Enjoy.',
      data:  { booking_id: booking.id, type: 'in_progress' },
    }).catch(e => console.warn('[notify]', e.message))

    res.json({ ok: true, status: 'in_progress' })
  } catch (err) { next(err) }
})

/* PATCH /api/bookings/:id/complete — barber finishes (spec 0023).
   Transitions in_progress → awaiting_confirmation. Does NOT capture the PI;
   that waits for /confirm or auto-confirm. Photo upload is optional. */
router.patch('/:id/complete', requireAuth, requireRole('barber'), idempotency(),
  completionUpload.single('photo'),
  async (req, res, next) => {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      'SELECT * FROM bookings WHERE id = $1 FOR UPDATE',
      [req.params.id]
    )
    const booking = rows[0]
    if (!booking) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }
    if (booking.barber_id !== req.user.id) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Forbidden' }) }
    if (!canTransitionOrReject(client, res, booking.status, 'awaiting_confirmation')) return

    const photoUrl = req.file ? `/uploads/completions/${req.file.filename}` : null

    await client.query(
      `UPDATE bookings
          SET status = 'awaiting_confirmation',
              completion_photo_url = COALESCE($2, completion_photo_url)
        WHERE id = $1`,
      [booking.id, photoUrl]
    )
    await logEvent(client, booking.id, req.user.id, booking.status, 'awaiting_confirmation', { photo: !!photoUrl })
    await client.query('COMMIT')

    cancelAutoComplete(booking.id).catch(() => {})
    // Schedule auto-confirm — if customer doesn't /confirm or /dispute in N min, capture anyway.
    const { getSetting } = await import('../services/settings.js')
    const autoMin = parseInt(await getSetting('auto_confirm_minutes')) || 10
    scheduleAutoConfirm(booking.id, autoMin * 60_000).catch(() => {})

    emitToUsers([booking.customer_id, req.user.id], 'booking_updated', {
      booking_id: booking.id, status: 'awaiting_confirmation', photo_url: photoUrl,
    })
    sendNotification(booking.customer_id, {
      title: 'Did your barber finish?',
      body:  `Tap to confirm and release payment. Auto-confirms in ${autoMin} min.`,
      data:  { booking_id: booking.id, type: 'awaiting_confirmation' },
    }).catch(e => console.warn('[notify]', e.message))

    res.json({ ok: true, status: 'awaiting_confirmation', photo_url: photoUrl })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    next(err)
  } finally {
    client.release()
  }
})

/* PATCH /api/bookings/:id/confirm — customer confirms completion (spec 0023).
   Captures the PI, transitions awaiting_confirmation → completed. Optionally
   accepts a tip (spec 0042); tip is a separate PI that flows 100% to the
   barber's Connect account with no application fee. */
router.patch('/:id/confirm', requireAuth, requireRole('customer'), idempotency(), async (req, res, next) => {
  const client = await getClient()
  try {
    // Tip is optional. Capped at 100% of price (or $1000 absolute).
    const tipRaw = parseInt(req.body?.tip_cents)
    const tipCents = Number.isFinite(tipRaw) && tipRaw > 0 ? Math.min(tipRaw, 100_000) : 0

    await client.query('BEGIN')
    const { rows } = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [req.params.id])
    const booking = rows[0]
    if (!booking) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }) }
    if (booking.customer_id !== req.user.id) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'forbidden' }) }
    if (!canTransitionOrReject(client, res, booking.status, 'completed')) return
    if (tipCents > booking.price_cents) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'tip_exceeds_price' })
    }

    await client.query(
      `UPDATE bookings SET status='completed', completion_confirmed_at = now(), tip_cents = $2 WHERE id = $1`,
      [booking.id, tipCents]
    )
    await logEvent(client, booking.id, req.user.id, booking.status, 'completed', { confirmed_by: 'customer', tip_cents: tipCents })
    await client.query('COMMIT')

    cancelAutoConfirm(booking.id).catch(() => {})
    // Capture the service PI now. Idempotency key matches the legacy capture
    // key so an auto-confirm + manual confirm race doesn't double-capture.
    if (stripe && booking.stripe_payment_intent_id) {
      try {
        await stripe.paymentIntents.capture(booking.stripe_payment_intent_id, {
          idempotencyKey: `booking_capture_${booking.id}`,
        })
      } catch (err) {
        console.error('[Stripe capture]', err.message)
        return res.json({ ok: true, status: 'completed', warning: 'Payment capture pending' })
      }
    }

    // Tipping (spec 0042). Separate PI so refund math stays clean. Capture
    // immediate, no application fee, transfer 100% to barber Connect account.
    let extraFields = {}
    if (stripe && tipCents > 0) {
      try {
        const { rows: cu } = await query(
          `SELECT u.stripe_customer_id, u.default_payment_method_id, b.stripe_account_id
             FROM users u, users b
            WHERE u.id = $1 AND b.id = $2`,
          [booking.customer_id, booking.barber_id]
        )
        const customerId  = cu[0]?.stripe_customer_id
        const barberAcct  = cu[0]?.stripe_account_id
        // MONEY-8: prefer the PM used for the service charge; fall back to default.
        const pmId = booking.service_payment_method_id || cu[0]?.default_payment_method_id
        if (customerId && barberAcct && pmId) {
          const tipPi = await stripe.paymentIntents.create({
            amount: tipCents,
            currency: 'usd',
            customer: customerId,
            payment_method: pmId,
            confirm: true,
            off_session: true,
            transfer_data: { destination: barberAcct },
            metadata: { booking_id: booking.id, type: 'tip' },
          }, { idempotencyKey: `booking_tip_${booking.id}` })
          await query(`UPDATE bookings SET tip_payment_intent_id = $1 WHERE id = $2`, [tipPi.id, booking.id])
        }
      } catch (tipErr) {
        // Tip failure does NOT roll back the booking — service charge is captured,
        // tip is best-effort. Log a booking_event so admins can follow up.
        await logEvent(null, booking.id, req.user.id, 'completed', 'completed',
          { type: 'tip_failed', error: tipErr.message }).catch(() => {})
        extraFields = { ...extraFields, tip_failed: true }
      }
    }

    emitToUsers([booking.customer_id, booking.barber_id], 'booking_updated', { booking_id: booking.id, status: 'completed' })
    sendNotification(booking.barber_id, {
      title: 'Payment released',
      body:  `Customer confirmed. $${((booking.price_cents * (await getBarberShare())) / 100).toFixed(2)} on the way.`,
      data:  { booking_id: booking.id, type: 'payout' },
    }).catch(() => {})

    res.json({ ok: true, status: 'completed' })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    next(err)
  } finally {
    client.release()
  }
})

/* PATCH /api/bookings/:id/dispute — customer says something's wrong (spec 0023).
   Cancels the PI (no capture), marks the booking cancelled, flags for admin. */
router.patch('/:id/dispute', requireAuth, requireRole('customer'), idempotency(), async (req, res, next) => {
  const client = await getClient()
  try {
    const reason = z.enum(['service_not_completed', 'quality_issue', 'barber_no_show']).parse(req.body?.reason)
    const notes  = String(req.body?.notes || '').trim()

    await client.query('BEGIN')
    const { rows } = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [req.params.id])
    const booking = rows[0]
    if (!booking) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }) }
    if (booking.customer_id !== req.user.id) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'forbidden' }) }
    if (!canTransitionOrReject(client, res, booking.status, 'cancelled')) return

    await client.query(
      `UPDATE bookings
          SET status = 'cancelled',
              completion_disputed_at  = now(),
              completion_dispute_reason = $2,
              cancellation_reason     = $3,
              cancelled_by            = 'customer'
        WHERE id = $1`,
      [booking.id, reason, notes || `disputed completion: ${reason}`]
    )
    await logEvent(client, booking.id, req.user.id, booking.status, 'cancelled', { type: 'completion_dispute', reason, notes })
    await client.query('COMMIT')

    cancelAutoConfirm(booking.id).catch(() => {})
    // Release the hold — no money moves.
    if (stripe && booking.stripe_payment_intent_id) {
      stripe.paymentIntents.cancel(booking.stripe_payment_intent_id, {
        idempotencyKey: `booking_cancel_${booking.id}`,
      }).catch(e => console.warn('[Stripe cancel dispute]', e.message))
    }

    emitToUsers([booking.customer_id, booking.barber_id], 'booking_updated', {
      booking_id: booking.id, status: 'cancelled', disputed: true,
    })
    sendNotification(booking.barber_id, {
      title: 'Completion disputed',
      body:  'The customer reported an issue. Admin will follow up.',
      data:  { booking_id: booking.id, type: 'completion_disputed' },
    }).catch(() => {})
    // Notify all admins via the same all-channels pattern (spec 0011 decision).
    const adminRows = await query(`SELECT id FROM users WHERE role = 'admin'`)
    for (const a of adminRows.rows) {
      sendNotification(a.id, {
        title: 'Completion dispute',
        body:  `Booking ${booking.id.slice(0,8)}: ${reason}`,
        data:  { booking_id: booking.id, type: 'admin_completion_dispute' },
      }).catch(() => {})
    }

    res.json({ ok: true, status: 'cancelled', dispute_reason: reason })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
    next(err)
  } finally {
    client.release()
  }
})

/* GET /api/bookings/:id/cancel-preview — what would a cancellation cost right now? */
router.get('/:id/cancel-preview', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM bookings WHERE id = $1`, [req.params.id])
    const booking = rows[0]
    if (!booking) return res.status(404).json({ error: 'not_found' })
    if (req.user.role !== 'admin'
        && booking.customer_id !== req.user.id
        && booking.barber_id   !== req.user.id) {
      return res.status(403).json({ error: 'forbidden' })
    }
    const fee = await getCancellationFee(booking)
    res.json({
      cancellation_fee_cents: fee.fee_cents,
      refund_amount_cents:    Math.max(0, booking.price_cents - fee.fee_cents),
      tier:                   fee.tier,
      minutes_until_scheduled: fee.minutes_until,
      reason:                 fee.reason,
    })
  } catch (err) { next(err) }
})

/* PATCH /api/bookings/:id/cancel  — customer cancels (only while requested/accepted) */
router.patch('/:id/cancel', requireAuth, idempotency(), async (req, res, next) => {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      'SELECT * FROM bookings WHERE id = $1 FOR UPDATE',
      [req.params.id]
    )
    const booking = rows[0]
    if (!booking) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }
    if (booking.customer_id !== req.user.id) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Forbidden' }) }
    if (!canTransitionOrReject(client, res, booking.status, 'cancelled')) return

    // Cancellation policy (spec 0013). Compute fee from current settings + booking state.
    const fee = await getCancellationFee(booking)
    const reason = req.body?.reason ?? null

    await client.query(
      `UPDATE bookings
          SET status = 'cancelled',
              cancelled_by = 'customer',
              cancellation_reason = $2,
              cancellation_fee_cents = $3
        WHERE id = $1`,
      [booking.id, reason, fee.fee_cents]
    )
    await logEvent(client, booking.id, req.user.id, booking.status, 'cancelled', { fee_cents: fee.fee_cents, tier: fee.tier })
    await client.query('COMMIT')

    let feeCharged = false
    if (stripe && booking.stripe_payment_intent_id && booking.status === 'accepted') {
      // MONEY-5: fee can't exceed what was actually authorized (price minus any promo discount).
      const authorizedAmount = booking.price_cents - (booking.promo_discount_cents || 0)
      const feeToCapture = Math.min(fee.fee_cents, authorizedAmount)
      if (feeToCapture > 0) {
        // Partial capture for the fee; Stripe auto-releases the rest of the hold.
        try {
          await stripe.paymentIntents.capture(booking.stripe_payment_intent_id, {
            amount_to_capture: feeToCapture,
          }, { idempotencyKey: `booking_cancel_fee_${booking.id}` })
          feeCharged = true
        } catch (err) {
          console.warn('[Stripe partial-capture cancel-fee]', err.message)
        }
      } else {
        // Full release.
        stripe.paymentIntents.cancel(booking.stripe_payment_intent_id, {
          idempotencyKey: `booking_cancel_${booking.id}`,
        }).catch(e => console.warn('[Stripe cancel]', e.message))
      }
    }
    cancelAutoCancel(booking.id).catch(() => {})
    cancelBarberNoShowCheck(booking.id).catch(() => {})
    emitToUsers([booking.barber_id, req.user.id], 'booking_updated', { booking_id: booking.id, status: 'cancelled' })
    sendNotification(booking.barber_id, {
      title: 'Booking cancelled',
      body:  fee.fee_cents > 0
        ? `Customer cancelled. $${(fee.fee_cents / 100).toFixed(2)} cancellation fee captured.`
        : 'The customer cancelled this request.',
      data:  { booking_id: booking.id, type: 'cancelled' },
    }).catch(() => {})

    res.json({
      ok: true,
      status: 'cancelled',
      cancellation_fee_cents: fee.fee_cents,
      fee_charged: feeCharged,
      refund_amount_cents: Math.max(0, booking.price_cents - fee.fee_cents),
    })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    next(err)
  } finally {
    client.release()
  }
})

/* POST /api/bookings/:id/no-show — barber flags the customer as a no-show.
   Spec 0013: allowed only by the booking's barber, only after the deadline
   window, only on `accepted` status. Captures customer_no_show_fee_bps of the
   PI for the barber, cancels the rest. */
router.post('/:id/no-show', requireAuth, requireRole('barber'), idempotency(), async (req, res, next) => {
  try {
    const notes = String(req.body?.notes || '').trim()
    if (notes.length < 10) {
      return res.status(400).json({ error: 'notes_too_short', message: 'Provide at least 10 chars describing what happened.' })
    }
    const { rows } = await query(`SELECT * FROM bookings WHERE id = $1`, [req.params.id])
    const booking = rows[0]
    if (!booking) return res.status(404).json({ error: 'not_found' })
    if (booking.barber_id !== req.user.id) return res.status(403).json({ error: 'forbidden' })
    if (booking.status !== 'accepted') {
      return res.status(409).json({ error: 'wrong_status', status: booking.status })
    }

    const { getSetting } = await import('../services/settings.js')
    const deadlineMin = parseInt(await getSetting('barber_no_show_deadline_minutes')) || 15
    const earliestNoShowAt = new Date(booking.scheduled_at).getTime() + deadlineMin * 60_000
    if (Date.now() < earliestNoShowAt) {
      return res.status(409).json({ error: 'too_early', message: `Wait until ${deadlineMin} min after the scheduled time before flagging no-show.` })
    }

    const feeBps = parseInt(await getSetting('customer_no_show_fee_bps')) || 5000
    const feeCents = Math.round(booking.price_cents * feeBps / 10_000)

    let feeCharged = false
    if (stripe && booking.stripe_payment_intent_id && feeCents > 0) {
      try {
        await stripe.paymentIntents.capture(booking.stripe_payment_intent_id, {
          amount_to_capture: feeCents,
        }, { idempotencyKey: `customer_no_show_${booking.id}` })
        feeCharged = true
      } catch (err) {
        console.warn('[Stripe no-show capture]', err.message)
      }
    }

    await query(
      `UPDATE bookings
          SET status = 'cancelled',
              cancelled_by = 'barber',
              cancellation_reason = $2,
              cancellation_fee_cents = $3,
              no_show_party = 'customer'
        WHERE id = $1`,
      [booking.id, notes, feeCents]
    )
    await logEvent(null, booking.id, req.user.id, booking.status, 'cancelled', {
      type: 'customer_no_show', fee_cents: feeCents, fee_charged: feeCharged,
    })

    cancelBarberNoShowCheck(booking.id).catch(() => {})
    emitToUsers([booking.customer_id, booking.barber_id], 'booking_updated', {
      booking_id: booking.id, status: 'cancelled', no_show_party: 'customer',
    })
    sendNotification(booking.customer_id, {
      title: 'Marked as no-show',
      body:  feeCents > 0
        ? `Your barber flagged this booking as a no-show. A $${(feeCents/100).toFixed(2)} fee was charged.`
        : 'Your barber flagged this booking as a no-show.',
      data:  { booking_id: booking.id, type: 'customer_no_show' },
    }).catch(() => {})

    res.json({ ok: true, fee_cents: feeCents, fee_charged: feeCharged })
  } catch (err) { next(err) }
})

/* Helper that rolls back the open tx if the FSM says no. Returns false if it sent a response. */
function canTransitionOrReject(client, res, from, to) {
  if (assertTransition(from, to, res)) return true
  client.query('ROLLBACK').catch(() => {})
  return false
}

export default router
