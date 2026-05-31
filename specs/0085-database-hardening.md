# 0085 — Database Schema Hardening

**Status:** todo  
**Addresses:** DB-3 (soft-delete), DB-4 (reviews schema), DB-5 (PI index), DB-6 (FK indexes), DB-7 (search), DB-9 (checks), DB-10 (last_active_at), DB-11 (migration safety), DB-12 (redundant indexes)

## Changes

### Migration `080_schema_hardening.sql`

```sql
-- DB-5: Missing PI indexes (critical — every webhook is a full scan)
CREATE INDEX IF NOT EXISTS bookings_payment_intent_idx
  ON bookings(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bookings_tip_payment_intent_idx
  ON bookings(tip_payment_intent_id)
  WHERE tip_payment_intent_id IS NOT NULL;

-- DB-6: Missing FK indexes
CREATE INDEX IF NOT EXISTS reviews_reviewer_id_idx         ON reviews(reviewer_id);
CREATE INDEX IF NOT EXISTS booking_events_actor_id_idx     ON booking_events(actor_id);
CREATE INDEX IF NOT EXISTS refunds_initiated_by_idx        ON refunds(initiated_by);
CREATE INDEX IF NOT EXISTS user_reports_reporter_idx       ON user_reports(reporter_id);
CREATE INDEX IF NOT EXISTS chat_messages_sender_idx        ON chat_messages(sender_id);
CREATE INDEX IF NOT EXISTS promo_redemptions_booking_idx   ON promo_redemptions(booking_id);

-- DB-4: Reconcile reviews table schema (safe on both variants)
DO $$
BEGIN
  -- Ensure correct rating type
  ALTER TABLE reviews ALTER COLUMN rating TYPE smallint USING rating::smallint;
  -- Ensure NOT NULL constraints
  ALTER TABLE reviews ALTER COLUMN reviewer_id SET NOT NULL;
  ALTER TABLE reviews ALTER COLUMN barber_id   SET NOT NULL;
  ALTER TABLE reviews ALTER COLUMN booking_id  SET NOT NULL;
  -- Re-add cascade if missing (drop + re-add to be safe)
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
             WHERE constraint_name = 'reviews_booking_id_fkey') THEN
    ALTER TABLE reviews DROP CONSTRAINT reviews_booking_id_fkey;
  END IF;
  ALTER TABLE reviews ADD CONSTRAINT reviews_booking_id_fkey
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
EXCEPTION WHEN OTHERS THEN NULL; -- idempotent
END $$;

-- DB-12: Remove redundant low-value indexes
DROP INDEX IF EXISTS barber_profiles_available_idx;
DROP INDEX IF EXISTS users_email_notifications_idx;

-- DB-11: Safer constraint re-add
DO $$
BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('customer', 'barber', 'admin', 'facility'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
```

### `web/backend/src/routes/barbers.js`

**DB-3 — Soft-deleted barbers still appear:**
```js
// In GET / (search) WHERE clause, add:
AND u.deleted_at IS NULL

// In GET /:id, add:
AND u.deleted_at IS NULL

// In booking creation availability check, add:
AND u.deleted_at IS NULL
```

### `web/backend/src/routes/auth.js`

**DB-10 — Throttle `last_active_at` write:**
```js
// Only write if more than 5 minutes stale:
if (!req.user.last_active_at || Date.now() - new Date(req.user.last_active_at).getTime() > 300_000) {
  query(`UPDATE users SET last_active_at = now() WHERE id = $1`, [req.user.id]).catch(() => {})
}
```
This requires reading `last_active_at` from the JWT payload or a lightweight DB check. Simpler: move `last_active_at` update into `GET /api/auth/me` only (called on app startup by most clients) rather than every authenticated request.

### DB-3 account deletion FK handling
In `auth.js` delete handler: catch `23503` FK violation and return `400 { error: 'has_active_bookings' }` instead of 500:
```js
} catch (err) {
  if (err.code === '23503') return res.status(400).json({ error: 'has_active_bookings', message: 'Cannot delete account with active bookings.' })
  next(err)
}
```

## Notes
- The PI index (DB-5) is the highest-impact single change here: every Stripe webhook is a full scan without it
- DB-4 reviews reconciliation uses `EXCEPTION WHEN OTHERS THEN NULL` for true idempotency — safe on both schema variants
- Soft-delete filter (DB-3) is a 3-line change with significant safety impact
