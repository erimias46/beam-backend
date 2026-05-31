// Refunds — see specs/0012-refunds-flow.md.
//
// Two entry points:
//   1. POST /api/admin/bookings/:id/refund      — admin can partial-refund any paid booking
//   2. POST /api/bookings/:id/refund            — customer self-service within refund window
//
// Both write a `refunds` row, call Stripe with a deterministic idempotency key
// (spec 0010), then update the row to 'succeeded' / 'failed'. The trigger on
// `refunds` keeps `bookings.refunded_cents` in sync. Refunds never flip
// `bookings.status` — status is business state, refunds are money events.
// Spec 0011 mirrors payment_state separately.

import { Router } from 'express'
import { z } from 'zod'
import Stripe from 'stripe'
import { query, getClient } from '../db/index.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { idempotency } from '../middleware/idempotency.js'
import { getSetting } from '../services/settings.js'
import { sendNotification } from '../services/notifications.js'

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null

const CUSTOMER_REASONS = ['service_incomplete', 'quality_issue']
const ADMIN_REASONS = [
  'requested_by_customer', 'duplicate', 'fraudulent', 'barber_no_show',
  'service_incomplete', 'quality_issue', 'admin_other',
]

const AdminBodySchema = z.object({
  amount_cents: z.number().int().positive().optional(),
  reason:       z.enum(ADMIN_REASONS),
  notes:        z.string().max(2000).optional(),
})

const CustomerBodySchema = z.object({
  reason: z.enum(CUSTOMER_REASONS),
  notes:  z.string().max(2000).optional(),
})

// Shared core: insert a pending refund row, call Stripe, update with result.
async function executeRefund({ booking, amount_cents, reason, notes, initiated_by, initiated_by_role }) {
  if (!stripe) throw Object.assign(new Error('Stripe not configured'), { status: 503 })
  if (!booking.stripe_payment_intent_id) {
    throw Object.assign(new Error('Booking has no PaymentIntent'), { status: 400, code: 'no_payment_intent' })
  }
  if (!['paid', 'completed'].includes(booking.status)) {
    throw Object.assign(new Error('Booking not refundable in current status'), {
      status: 400, code: 'booking_not_refundable',
    })
  }

  const remaining = booking.price_cents - (booking.refunded_cents || 0)
  const refundAmount = amount_cents ?? remaining
  if (refundAmount <= 0 || refundAmount > remaining) {
    throw Object.assign(new Error('Amount exceeds remaining refundable balance'), {
      status: 400, code: 'refund_exceeds_remaining', meta: { remaining_cents: remaining },
    })
  }

  const client = await getClient()
  let refundRow
  try {
    await client.query('BEGIN')
    const insert = await client.query(
      `INSERT INTO refunds
         (booking_id, amount_cents, reason, initiated_by, initiated_by_role, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING *`,
      [booking.id, refundAmount, reason, initiated_by, initiated_by_role, notes ?? null]
    )
    refundRow = insert.rows[0]
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  try {
    // Deterministic idempotency key per refund row — safe across retries.
    // Note: refund_application_fee:true tells Stripe to also refund our app
    // fee proportionally. With destination charges this is usually default
    // but explicit is safer (resolves spec 0012 open question).
    const stripeRefund = await stripe.refunds.create({
      payment_intent: booking.stripe_payment_intent_id,
      amount: refundAmount,
      reason: ['requested_by_customer', 'duplicate', 'fraudulent'].includes(reason) ? reason : undefined,
      metadata: { booking_id: booking.id, refund_id: refundRow.id, reason },
      refund_application_fee: true,
    }, { idempotencyKey: `refund_${refundRow.id}` })

    const update = await query(
      `UPDATE refunds
          SET stripe_refund_id = $1, status = 'succeeded', succeeded_at = now()
        WHERE id = $2
        RETURNING *`,
      [stripeRefund.id, refundRow.id]
    )
    refundRow = update.rows[0]

    // Notify barber — spec 0012 confirmed yes (benny, 2026-05-28).
    sendNotification(booking.barber_id, {
      title: 'Booking refunded',
      body:  `$${(refundAmount / 100).toFixed(2)} refunded on booking ${booking.id.slice(0, 8)}.`,
      data:  { booking_id: booking.id, type: 'refund_succeeded', amount_cents: refundAmount },
    }).catch(() => {})

    // Audit row
    await query(
      `INSERT INTO booking_events (booking_id, actor_id, from_status, to_status, meta)
         VALUES ($1, $2, $3, $3, $4)`,
      [booking.id, initiated_by, booking.status, JSON.stringify({
        type: 'refund', refund_id: refundRow.id, amount_cents: refundAmount, reason,
      })]
    ).catch(() => {})

    return refundRow
  } catch (stripeErr) {
    await query(
      `UPDATE refunds
          SET status = 'failed', stripe_error = $1
        WHERE id = $2`,
      [stripeErr.message?.slice(0, 1000) || String(stripeErr).slice(0, 1000), refundRow.id]
    )
    throw Object.assign(new Error('Stripe refund failed: ' + stripeErr.message), {
      status: 502, code: 'stripe_refund_failed',
    })
  }
}

/* ─── Admin handler ──────────────────────────────────────── */
export const adminRefundRouter = Router()

adminRefundRouter.post('/bookings/:id/refund',
  requireAuth, requireRole('admin'), idempotency(),
  async (req, res, next) => {
    try {
      const body = AdminBodySchema.parse(req.body || {})
      const { rows } = await query(`SELECT * FROM bookings WHERE id = $1`, [req.params.id])
      const booking = rows[0]
      if (!booking) return res.status(404).json({ error: 'booking_not_found' })

      const refund = await executeRefund({
        booking,
        amount_cents:      body.amount_cents,
        reason:            body.reason,
        notes:             body.notes,
        initiated_by:      req.user.id,
        initiated_by_role: 'admin',
      })
      res.json({ refund })
    } catch (err) {
      if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
      if (err.status) return res.status(err.status).json({ error: err.code || 'refund_failed', message: err.message, ...(err.meta || {}) })
      next(err)
    }
  }
)

/* ─── Customer handler ───────────────────────────────────── */
export const customerRefundRouter = Router({ mergeParams: true })

customerRefundRouter.post('/:id/refund',
  requireAuth, requireRole('customer'), idempotency(),
  async (req, res, next) => {
    try {
      const body = CustomerBodySchema.parse(req.body || {})
      const { rows } = await query(`SELECT * FROM bookings WHERE id = $1`, [req.params.id])
      const booking = rows[0]
      if (!booking) return res.status(404).json({ error: 'booking_not_found' })
      if (booking.customer_id !== req.user.id) return res.status(403).json({ error: 'forbidden' })
      // Allow refund when status='paid' OR payment_state='captured' (webhook may be delayed — spec 0082)
      if (booking.status !== 'paid' && booking.payment_state !== 'captured') {
        return res.status(403).json({ error: 'refund_only_for_paid', message: 'Refunds via self-service require paid status. Contact support otherwise.' })
      }
      if ((booking.refunded_cents || 0) > 0) {
        return res.status(403).json({ error: 'refund_requires_admin', message: 'A partial refund already exists. Contact support for any additional refunds.' })
      }

      const windowHours = parseInt(await getSetting('refund_window_hours')) || 24
      // Use paid_at (set by webhook, migration 078) for precise window anchor.
      // Falls back to updated_at for bookings paid before migration 078 was applied.
      const paidAt = booking.paid_at || booking.updated_at
      const ageMs = Date.now() - new Date(paidAt).getTime()
      if (ageMs > windowHours * 3_600_000) {
        return res.status(403).json({ error: 'refund_window_closed', message: `Self-service refunds are available within ${windowHours} hours of payment.` })
      }

      const refund = await executeRefund({
        booking,
        amount_cents:      undefined, // full
        reason:            body.reason,
        notes:             body.notes,
        initiated_by:      req.user.id,
        initiated_by_role: 'customer',
      })
      res.json({ refund })
    } catch (err) {
      if (err.name === 'ZodError') return res.status(400).json({ error: err.errors })
      if (err.status) return res.status(err.status).json({ error: err.code || 'refund_failed', message: err.message, ...(err.meta || {}) })
      next(err)
    }
  }
)

/* ─── Listing endpoints ──────────────────────────────────── */
export const refundsListRouter = Router()

refundsListRouter.get('/bookings/:id/refunds', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM bookings WHERE id = $1`, [req.params.id])
    const booking = rows[0]
    if (!booking) return res.status(404).json({ error: 'booking_not_found' })
    if (req.user.role !== 'admin'
        && booking.customer_id !== req.user.id
        && booking.barber_id   !== req.user.id) {
      return res.status(403).json({ error: 'forbidden' })
    }
    const refunds = await query(
      `SELECT * FROM refunds WHERE booking_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    )
    res.json({ refunds: refunds.rows })
  } catch (err) { next(err) }
})

refundsListRouter.get('/admin/refunds', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const status = req.query.status
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200)
    const params = []
    let where = ''
    if (status) {
      params.push(status)
      where = `WHERE r.status = $1`
    }
    params.push(limit)
    const { rows } = await query(
      `SELECT r.*, b.customer_id, b.barber_id, b.price_cents
         FROM refunds r
         JOIN bookings b ON b.id = r.booking_id
        ${where}
        ORDER BY r.created_at DESC
        LIMIT $${params.length}`,
      params
    )
    res.json({ refunds: rows })
  } catch (err) { next(err) }
})
