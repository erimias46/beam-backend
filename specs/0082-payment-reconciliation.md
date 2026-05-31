# 0082 — Payment Reconciliation + Durable Timers

**Status:** todo  
**Addresses:** MONEY-1 (stuck payments), MONEY-2 (Redis-only timers), MONEY-10 (failed event flips completed), MONEY-11 (charge.refunded drift)

## Problem

1. **Stuck payments**: `paid` is set exclusively by the `payment_intent.succeeded` webhook. If the webhook is lost/parked, booking stuck in `completed` forever — customer can't self-refund, barber payout never recorded, admin has no visibility.

2. **Durable timers**: auto-cancel/auto-confirm/no-show jobs stored only in BullMQ/Redis. Redis blip = jobs vanish silently. No fallback.

3. **Out-of-order failure event**: `payment_intent.payment_failed` matches `status IN ('completed')` — an out-of-order event can flip a captured booking to cancelled.

4. **charge.refunded drift**: `charge.refunds.data` not expanded by default → dashboard refunds don't sync.

## Changes

### Migration `077_durable_timers.sql`
```sql
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS auto_cancel_at    timestamptz,
  ADD COLUMN IF NOT EXISTS auto_confirm_at   timestamptz;

CREATE INDEX IF NOT EXISTS bookings_auto_cancel_idx
  ON bookings(auto_cancel_at) WHERE auto_cancel_at IS NOT NULL AND status = 'requested';
CREATE INDEX IF NOT EXISTS bookings_auto_confirm_idx
  ON bookings(auto_confirm_at) WHERE auto_confirm_at IS NOT NULL AND status = 'awaiting_confirmation';
```

### `web/backend/src/services/queue.js`

On schedule calls, write the timer column in the same transaction as the status update:
```js
// scheduleAutoCancel: alongside the booking insert, set:
await client.query(
  `UPDATE bookings SET auto_cancel_at = $1 WHERE id = $2`,
  [new Date(Date.now() + delay_ms), bookingId]
)
// Clear on accept/decline:
await client.query(`UPDATE bookings SET auto_cancel_at = NULL WHERE id = $1`, [bookingId])
```

Add a **DB sweep worker** (runs every 60s via BullMQ repeatable job):
```js
// auto-cancel sweep
const { rows } = await query(
  `UPDATE bookings SET status='cancelled', auto_cancel_at=NULL
   WHERE auto_cancel_at <= now() AND status='requested'
   RETURNING *`
)
// auto-confirm sweep
const { rows } = await query(
  `UPDATE bookings SET status='completed', completion_confirmed_at=now(), auto_confirm_at=NULL
   WHERE auto_confirm_at <= now() AND status='awaiting_confirmation'
   RETURNING *`
)
// then for each row: trigger Stripe capture (same as current worker)
```

The BullMQ delay jobs remain as the primary mechanism; the DB sweep is the fallback.

### `web/backend/src/routes/stripe.js`

**MONEY-10 fix:** Remove `'completed'` from the `payment_failed` handler status list:
```js
WHERE id = $1 AND status IN ('requested', 'accepted', 'in_progress')
```

**MONEY-11 fix:** Expand refunds in `charge.refunded` handler:
```js
const charge = await stripe.charges.retrieve(event.data.object.id, {
  expand: ['refunds']
})
```
Upsert any refund not already in `refunds` table:
```js
for (const r of charge.refunds.data) {
  await query(
    `INSERT INTO refunds (booking_id, stripe_refund_id, amount_cents, status, succeeded_at, reason, initiated_by_role)
     VALUES ($1, $2, $3, 'succeeded', $4, $5, 'stripe_dashboard')
     ON CONFLICT (stripe_refund_id) DO NOTHING`,
    [booking.id, r.id, r.amount, new Date(r.created * 1000), r.reason || 'other']
  )
}
```

### **Reconciliation sweep** (new: `services/reconciliation.js`)

Scheduled every 10 minutes via BullMQ repeatable job. For bookings in `completed` or `awaiting_confirmation` older than 5 minutes:
```js
const stale = await query(
  `SELECT id, stripe_payment_intent_id FROM bookings
   WHERE status IN ('completed', 'awaiting_confirmation')
     AND updated_at < now() - interval '5 minutes'
     AND stripe_payment_intent_id IS NOT NULL`
)
for (const b of stale.rows) {
  const pi = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id)
  if (pi.status === 'succeeded') {
    // Flip to paid — same logic as webhook handler
    await query(`UPDATE bookings SET status='paid', payment_state='captured' WHERE id=$1 AND status='completed'`, [b.id])
  } else if (pi.status === 'requires_capture') {
    // Attempt capture (for stuck awaiting_confirmation)
    await stripe.paymentIntents.capture(b.stripe_payment_intent_id, ...)
  } else if (['canceled', 'payment_failed'].includes(pi.status)) {
    // Alert admin — money state mismatch
    await logEvent(b.id, null, booking.status, booking.status, { type: 'reconciliation_alert', pi_status: pi.status })
  }
}
```

Also allow self-service refund when `payment_state = 'captured'` regardless of whether `status` has reached `'paid'`:
```js
// refunds.js:174 — change:
if (booking.status !== 'paid' && booking.payment_state !== 'captured') { ... 403 ... }
```

## Notes
- Stripe key required for reconciliation to run — skip silently if not configured
- Reconciliation is read-heavy (one PI retrieve per stale booking); run max 20 in parallel
- Alert channel: `logEvent` creates an admin-visible audit row; future: Slack/email alert
