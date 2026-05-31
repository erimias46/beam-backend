import { query } from '../db/index.js'
import { getSetting } from './settings.js'

const MAX_STALE_MINUTES = 10
const BATCH_SIZE = 20

export async function runReconciliation() {
  let stripe
  try {
    const Stripe = (await import('stripe')).default
    if (!process.env.STRIPE_SECRET_KEY) return
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
  } catch { return }

  const { rows: stale } = await query(
    `SELECT id, stripe_payment_intent_id, status, payment_state, barber_id, customer_id, price_cents
     FROM bookings
     WHERE status IN ('completed', 'awaiting_confirmation')
       AND updated_at < now() - interval '${MAX_STALE_MINUTES} minutes'
       AND stripe_payment_intent_id IS NOT NULL
     LIMIT ${BATCH_SIZE}`
  )

  for (const booking of stale) {
    try { await reconcileBooking(booking, stripe) }
    catch (err) { console.error(`[reconcile] booking ${booking.id} failed:`, err.message) }
  }
}

async function reconcileBooking(booking, stripe) {
  const pi = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id)

  if (pi.status === 'succeeded') {
    const { rowCount } = await query(
      `UPDATE bookings
          SET status='paid', paid_at=to_timestamp($1), payment_state='captured'
        WHERE id=$2 AND status='completed'`,
      [pi.created, booking.id]
    )
    if (rowCount) {
      console.info(`[reconcile] Fixed stuck payment: booking ${booking.id}`)
      const { sendNotification } = await import('./notifications.js')
      sendNotification(booking.barber_id, {
        title: 'Payment confirmed',
        body: `Payment for booking has been confirmed.`,
        data: { booking_id: booking.id, type: 'payment_reconciled' },
      }).catch(() => {})
    }

  } else if (pi.status === 'requires_capture') {
    try {
      await stripe.paymentIntents.capture(booking.stripe_payment_intent_id)
      console.info(`[reconcile] Captured PI for booking ${booking.id}`)
    } catch (captureErr) {
      await logAlert(booking.id, booking.status, 'capture_failed', captureErr.message)
    }

  } else if (['canceled', 'payment_failed'].includes(pi.status)) {
    await logAlert(booking.id, booking.status, `stripe_${pi.status}`, null)
  }
}

async function logAlert(bookingId, fromStatus, type, message) {
  await query(
    `INSERT INTO booking_events (booking_id, actor_id, from_status, to_status, meta)
     VALUES ($1, NULL, $2, $2, $3)`,
    [bookingId, fromStatus, JSON.stringify({ type: `reconciliation_alert:${type}`, message })]
  ).catch(() => {})
  console.error(`[reconcile] ALERT booking ${bookingId}: ${type}${message ? ' — ' + message : ''}`)
}
