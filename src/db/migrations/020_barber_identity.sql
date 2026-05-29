-- Beam0: Stripe Identity verification for barbers. See specs/0020-stripe-identity-verification.md.
--
-- One-time gate before a barber can accept their first booking. We never see
-- the ID or selfie — Stripe Identity collects them and we just receive a
-- verified / failed result via webhook.

ALTER TABLE barber_profiles
  ADD COLUMN IF NOT EXISTS identity_status text NOT NULL DEFAULT 'unverified'
    CHECK (identity_status IN ('unverified','pending','verified','failed','requires_input')),
  ADD COLUMN IF NOT EXISTS identity_session_id     text,
  ADD COLUMN IF NOT EXISTS identity_verified_at    timestamptz,
  ADD COLUMN IF NOT EXISTS identity_failure_reason text;

CREATE INDEX IF NOT EXISTS barber_profiles_identity_status_idx
  ON barber_profiles (identity_status);
