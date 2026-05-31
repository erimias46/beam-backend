-- Beam0: paid_at timestamp + service_payment_method_id (specs 0082, 0083).
-- paid_at: set by payment_intent.succeeded webhook. Replaces updated_at as the
--   refund-window anchor so post-payment writes don't shift the clock.
-- service_payment_method_id: the PM used for the main service charge, persisted
--   at accept time so tips and partial charges reuse the same card.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS paid_at                    timestamptz,
  ADD COLUMN IF NOT EXISTS service_payment_method_id  text;

CREATE INDEX IF NOT EXISTS bookings_paid_at_idx
  ON bookings(paid_at) WHERE paid_at IS NOT NULL;
