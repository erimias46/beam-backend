-- Beam0: schema hardening — indexes, FK indexes, reviews reconciliation,
-- redundant index removal (spec 0085).

-- DB-5: Stripe PI indexes (every webhook was a full scan)
CREATE INDEX IF NOT EXISTS bookings_payment_intent_idx
  ON bookings(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bookings_tip_payment_intent_idx
  ON bookings(tip_payment_intent_id)
  WHERE tip_payment_intent_id IS NOT NULL;

-- DB-6: Missing FK indexes
CREATE INDEX IF NOT EXISTS reviews_reviewer_id_idx        ON reviews(reviewer_id);
CREATE INDEX IF NOT EXISTS booking_events_actor_id_idx    ON booking_events(actor_id);
CREATE INDEX IF NOT EXISTS refunds_initiated_by_idx       ON refunds(initiated_by);
CREATE INDEX IF NOT EXISTS user_reports_reporter_idx      ON user_reports(reporter_id);
CREATE INDEX IF NOT EXISTS chat_messages_sender_idx       ON chat_messages(sender_id);
CREATE INDEX IF NOT EXISTS promo_redemptions_booking_idx  ON promo_redemptions(booking_id);

-- DB-4: Reconcile reviews table schema (safe on both 001 and 003 variants)
DO $$
BEGIN
  -- Ensure correct rating type
  BEGIN
    ALTER TABLE reviews ALTER COLUMN rating TYPE smallint USING rating::smallint;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  -- Ensure cascade on booking FK
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'reviews_booking_id_fkey'
    ) THEN
      ALTER TABLE reviews DROP CONSTRAINT reviews_booking_id_fkey;
    END IF;
    ALTER TABLE reviews ADD CONSTRAINT reviews_booking_id_fkey
      FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

-- DB-12: Remove redundant low-selectivity indexes
DROP INDEX IF EXISTS barber_profiles_available_idx;
DROP INDEX IF EXISTS users_email_notifications_idx;

-- DB-11: Safer constraint re-add (admin role guard, now that admin can't self-signup)
DO $$
BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('customer', 'barber', 'admin', 'facility'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
