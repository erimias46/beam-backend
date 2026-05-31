# 0084 — Credit System + Atomic Ledger

**Status:** todo  
**Addresses:** DB-2 (credit overdraw race), MONEY-9 (credits never spent), MONEY-12 (double-award)

## Problem

1. **DB-2**: `applyCredit` reads balance then inserts at READ COMMITTED with no lock → concurrent debits overdraw.
2. **Credits never spent**: `credit_applied_cents` column and `user_credits` ledger exist, but nothing in the booking flow spends credits.
3. **MONEY-12**: Referral credit award has no uniqueness guard — concurrent `succeeded` webhooks double-award.

## Changes

### Migration `079_credit_uniqueness.sql`
```sql
-- Prevent double-awarding the same credit source
ALTER TABLE user_credits
  ADD COLUMN IF NOT EXISTS source_ref text;

CREATE UNIQUE INDEX IF NOT EXISTS user_credits_source_ref_idx
  ON user_credits(user_id, source, source_ref)
  WHERE source_ref IS NOT NULL;

ALTER TABLE user_credits
  ADD CONSTRAINT user_credits_balance_non_negative
  CHECK (balance_after_cents >= 0);
```

### `web/backend/src/routes/promos.js`

**Atomic spend in `applyCredit`:**
```js
async function applyCredit(userId, amountCents, source, sourceRef, client) {
  // Lock the user's credit rows to prevent concurrent overdraw
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount_cents), 0) AS balance
     FROM user_credits
     WHERE user_id = $1
       AND (expires_at IS NULL OR expires_at > now())
     FOR UPDATE`,
    [userId]
  )
  const balance = parseInt(rows[0].balance)
  if (balance < amountCents) throw Object.assign(new Error('Insufficient credits'), { status: 402, code: 'insufficient_credits' })

  const newBalance = balance - amountCents
  await client.query(
    `INSERT INTO user_credits (user_id, amount_cents, source, source_ref, balance_after_cents)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, -amountCents, source, sourceRef, newBalance]
  )
  return amountCents
}
```

**Credit spend at checkout** (`routes/bookings.js` POST `/`):
- Accept optional `credit_cents` in booking request body (validated: must be ≤ balance, ≤ price_cents - 50 minimum charge)
- If provided, call `applyCredit(userId, credit_cents, 'booking', bookingId, client)` inside the booking transaction
- Store as `credit_applied_cents` on the booking
- The PI is authorized for `price_cents - credit_applied_cents - promo_discount_cents`

**Referral award idempotency** (`routes/stripe.js`):
```js
await query(
  `INSERT INTO user_credits (user_id, amount_cents, source, source_ref, balance_after_cents)
   SELECT $1, $2, 'referral', $3,
     COALESCE((SELECT balance_after_cents FROM user_credits WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1), 0) + $2
   WHERE NOT EXISTS (SELECT 1 FROM user_credits WHERE source='referral' AND source_ref=$3)`,
  [referrerId, REFERRAL_CREDIT_CENTS, bookingId]
)
```
Or simpler with the unique index: `ON CONFLICT (user_id, source, source_ref) DO NOTHING`.

### `web/frontend/src/` + `app/lib/`

**Frontend**: Add a "Apply credits" toggle to the Book step 3 (payment) showing available balance; pass `credit_cents` in booking POST body.  
**Mobile**: Same in `book_screen.dart` — show credit balance pill, send `credit_cents` in booking payload.

## API changes
`POST /api/bookings` body gains optional `credit_cents: number` (validated ≤ balance and leaves min charge).  
`GET /api/credits/balance` response gains `spendable_cents` field.

## Notes
- Minimum charge floor: `price_cents - credit_applied_cents - promo_discount_cents >= 50` (Stripe minimum $0.50). If the combination would go below 50 cents, cap credits accordingly.
- Credits expire check already in the ledger query; use `FOR UPDATE` inside the booking transaction
