# 0091 — Stripe Reconciliation Service

**Status:** todo  
**Addresses:** MONEY-1 (stuck payments), Feature suggestion #1

## Problem

`paid` is set exclusively by the `payment_intent.succeeded` webhook. If the webhook fails permanently, money is captured at Stripe but the booking never reaches `paid` — the customer can't self-refund, the barber payout is never recorded, and no one is alerted.

## Architecture

A new service file `web/backend/src/services/reconciliation.js` registered as a BullMQ repeatable job (every 10 minutes).

### Implementation

```js
// services/reconciliation.js
import { stripe } from './stripe-client.js'
import { query, getClient } from '../db/index.js'
import { sendNotification } from './notifications.js'

const MAX_STALE_MINUTES = 10
const BATCH_SIZE = 20

export async function runReconciliation() {
  if (!stripe) return // Stripe not configured — skip

  // Find bookings that should have resolved by now
  const { rows: stale } = await query(
    `SELECT b.id, b.stripe_payment_intent_id, b.tip_payment_intent_id,
            b.status, b.payment_state, b.barber_id, b.customer_id, b.price_cents
     FROM bookings b
     WHERE b.status IN ('completed', 'awaiting_confirmation')
       AND b.updated_at < now() - interval '${MAX_STALE_MINUTES} minutes'
       AND b.stripe_payment_intent_id IS NOT NULL
     LIMIT ${BATCH_SIZE}`
  )

  for (const booking of stale) {
    try {
      await reconcileBooking(booking)
    } catch (err) {
      console.error(`[reconcile] booking ${booking.id} failed:`, err.message)
    }
  }
}

async function reconcileBooking(booking) {
  const pi = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id)

  if (pi.status === 'succeeded') {
    // Webhook was lost — manually flip to paid
    const { rowCount } = await query(
      `UPDATE bookings
          SET status = 'paid', paid_at = to_timestamp($1), payment_state = 'captured'
        WHERE id = $2 AND status = 'completed'`,
      [pi.created, booking.id]
    )
    if (rowCount) {
      console.info(`[reconcile] Fixed stuck payment: booking ${booking.id}`)
      // Notify barber
      await sendNotification(booking.barber_id, {
        title: 'Payment confirmed',
        body: `Payment for booking ${booking.id.slice(0,8)} has been confirmed.`,
        data: { booking_id: booking.id, type: 'payment_reconciled' },
      }).catch(() => {})
    }

  } else if (pi.status === 'requires_capture') {
    // Auto-confirm window passed but capture never happened — attempt capture now
    try {
      await stripe.paymentIntents.capture(booking.stripe_payment_intent_id)
      // The payment_intent.succeeded webhook will then flip to 'paid'
      console.info(`[reconcile] Captured PI for booking ${booking.id}`)
    } catch (captureErr) {
      await logReconciliationAlert(booking.id, 'capture_failed', captureErr.message)
    }

  } else if (['canceled', 'payment_failed'].includes(pi.status)) {
    // Mismatch: DB says completed/awaiting but Stripe says failed
    await logReconciliationAlert(booking.id, `stripe_${pi.status}`, pi.last_payment_error?.message)
  }
  // pi.status === 'processing' → skip (still in flight)
}

async function logReconciliationAlert(bookingId, type, message) {
  await query(
    `INSERT INTO booking_events (booking_id, actor_id, from_status, to_status, meta)
     SELECT id, NULL, status, status, $1
     FROM bookings WHERE id = $2`,
    [JSON.stringify({ type: `reconciliation_alert:${type}`, message }), bookingId]
  ).catch(() => {})
  console.error(`[reconcile] ALERT booking ${bookingId}: ${type} — ${message}`)
}
```

### Registration in `services/queue.js`

```js
// Add repeatable reconciliation job (every 10 min)
const reconciliationQueue = new Queue('reconciliation', { connection: redisOpts })
const reconciliationWorker = new Worker('reconciliation', async () => {
  const { runReconciliation } = await import('./reconciliation.js')
  await runReconciliation()
}, { connection: redisOpts })

await reconciliationQueue.add('sweep', {}, {
  repeat: { every: 10 * 60 * 1000 },
  removeOnComplete: 10,
  removeOnFail: 5,
})
```

### Admin visibility

Add `GET /api/admin/reconciliation-alerts` — returns booking_events rows with `meta->>'type' LIKE 'reconciliation_alert%'` ordered by newest. Shown in the admin dashboard.

## Refund eligibility fix

In `routes/refunds.js`, allow self-service refund when `payment_state = 'captured'` even if `status` hasn't reached `'paid'`:
```js
if (booking.status !== 'paid' && booking.payment_state !== 'captured') {
  return res.status(403).json({ error: 'refund_not_available' })
}
```

## Notes
- Reconciliation is idempotent — safe to re-run on same bookings
- Only runs when Stripe key is configured (no-op in dev/test)
- BATCH_SIZE=20 limits Stripe API calls per run; adjust based on volume
- Alerts go to `booking_events` now; wire to Slack/email webhook when monitoring (spec 0090) is live
