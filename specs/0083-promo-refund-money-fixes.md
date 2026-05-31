# 0083 — Promo/Refund Math + Idempotency + Tip Fixes

**Status:** todo  
**Addresses:** MONEY-5 (promo math), MONEY-6 (idempotency 4xx caching), MONEY-7 (refund window), MONEY-8 (tips), MONEY-9 (promo atomicity)

## Problem

1. **MONEY-5**: PI authorized for `price_cents − promo_discount_cents` but cancellation-fee capture and refund ceiling both use full `price_cents` → Stripe rejects over-authorized captures silently.

2. **MONEY-6**: Idempotency caches `402 requires_action` (3DS) and `409 in_flight` permanently → retries replay the error forever.

3. **MONEY-7**: Refund self-service window uses `updated_at` as proxy for `paid_at` — any post-payment write resets the clock.

4. **MONEY-8**: Tip PI uses `default_payment_method_id` (may differ from service charge PM); failures swallowed.

5. **MONEY-9**: Promo redeemed in a separate transaction from booking insert — one-time promo burned if the subsequent booking update fails.

## Changes

### Migration `078_paid_at_and_payment_method.sql`
```sql
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS paid_at                  timestamptz,
  ADD COLUMN IF NOT EXISTS service_payment_method_id text; -- PM used for the service charge
```
Set `paid_at` in the `payment_intent.succeeded` handler (stripe.js).  
Set `service_payment_method_id` at accept time (bookings.js).

### `web/backend/src/routes/bookings.js`

**MONEY-5 — cancellation fee clamp:**
```js
const authorizedAmount = booking.price_cents - (booking.promo_discount_cents || 0)
const feeToCapture = Math.min(fee.fee_cents, authorizedAmount)
```

**MONEY-8 — tip uses the right card:**
```js
// At accept (/accept): persist the PM used:
await client.query(`UPDATE bookings SET service_payment_method_id=$1 WHERE id=$2`, [paymentMethodId, booking.id])
// At tip (/confirm): use it:
const pmId = booking.service_payment_method_id || cu[0].default_payment_method_id
```
On tip failure: insert a `tip_failed` event in `booking_events` and return a warning to the customer (don't silently swallow):
```js
} catch (tipErr) {
  await logEvent(booking.id, req.user.id, 'completed', 'completed', { type: 'tip_failed', error: tipErr.message })
  // still complete — tip failure doesn't block completion, but customer is informed
  extraFields.tip_failed = true
}
```

**MONEY-9 — promo atomicity:** Move promo redemption inside the booking transaction:
```js
// Inside the BEGIN/COMMIT that inserts the booking:
await client.query(`UPDATE promos SET redemptions_used = redemptions_used + 1 WHERE code = $1`, [promoCode])
await client.query(`INSERT INTO promo_redemptions (...) VALUES (...)`, [...])
await client.query(`INSERT INTO bookings (..., promo_code, promo_discount_cents) VALUES (...)`, [...])
// If anything fails → ROLLBACK undoes both
```

### `web/backend/src/middleware/idempotency.js`

**MONEY-6 — don't cache actionable 4xx:**
```js
// After res.json override, before caching:
const SKIP_CACHE_STATUSES = new Set([402, 409])
if (SKIP_CACHE_STATUSES.has(statusCode)) return // don't persist; let client retry fresh
```

### `web/backend/src/routes/refunds.js`

**MONEY-7 — use `paid_at`:**
```js
const paidAt = booking.paid_at || booking.updated_at // fallback for old rows
const ageMs = Date.now() - new Date(paidAt).getTime()
```

**MONEY-5 — correct refund ceiling:**
```js
const capturedAmount = booking.price_cents - (booking.promo_discount_cents || 0) + (booking.tip_cents || 0)
const remaining = capturedAmount - (booking.refunded_cents || 0)
```

### `web/backend/src/routes/stripe.js`

Set `paid_at` when webhook fires:
```js
await query(`UPDATE bookings SET status='paid', paid_at=now(), payment_state='captured' WHERE id=$1 AND status='completed'`, [booking.id])
```

## Notes
- `service_payment_method_id` is best-effort; if null (old bookings), fall back to `default_payment_method_id`
- Tip failure creates a `booking_events` row — admin can see it, customer gets a `tip_failed:true` field in the confirm response
- The promo-in-transaction change requires testing with the existing promo test suite
