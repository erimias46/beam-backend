-- Track Stripe Connect onboarding state on barber profile
ALTER TABLE barber_profiles
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_payouts_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_details_submitted boolean NOT NULL DEFAULT false;

-- Index for webhook account.updated lookups
CREATE INDEX IF NOT EXISTS users_stripe_account_id_idx
  ON users(stripe_account_id) WHERE stripe_account_id IS NOT NULL;

-- Prevent a barber from accepting two bookings at the same time (soft guard via partial unique)
-- Active = not in a terminal state. Partial unique on (barber_id, scheduled_at).
CREATE UNIQUE INDEX IF NOT EXISTS bookings_barber_active_slot_idx
  ON bookings(barber_id, scheduled_at)
  WHERE status IN ('requested','accepted','in_progress');

-- Track audit info for status transitions
CREATE TABLE IF NOT EXISTS booking_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  actor_id    uuid REFERENCES users(id),
  from_status booking_status,
  to_status   booking_status NOT NULL,
  meta        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_events_booking_id_idx ON booking_events(booking_id);

-- OTP attempt log for stricter brute-force tracking
CREATE TABLE IF NOT EXISTS otp_attempts (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL,
  ip          inet,
  kind        text NOT NULL CHECK (kind IN ('send','verify','verify_fail')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_attempts_email_created_idx ON otp_attempts(email, created_at DESC);
CREATE INDEX IF NOT EXISTS otp_attempts_ip_created_idx ON otp_attempts(ip, created_at DESC);
