-- Beam0: stripe webhook replay dedupe + dead letter + finer payment state.
-- See specs/0011-stripe-webhook-hardening.md.
--
-- The dedupe pattern: every Stripe webhook delivery does
--   INSERT INTO stripe_webhook_events (id, type, payload, status='received')
--   ON CONFLICT (id) DO NOTHING
-- and only processes if the insert took the row. A retry from Stripe (or a
-- network blip on our ack) finds the row exists and ack-noop. The status
-- column tracks 'received' → 'processed' | 'failed' so we can retry failures.

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id            text        PRIMARY KEY,
  type          text        NOT NULL,
  payload       jsonb       NOT NULL,
  status        text        NOT NULL CHECK (status IN ('received','processed','failed','skipped')),
  attempts      int         NOT NULL DEFAULT 0,
  last_error    text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS stripe_webhook_events_type_idx
  ON stripe_webhook_events (type, received_at DESC);

CREATE INDEX IF NOT EXISTS stripe_webhook_events_failed_idx
  ON stripe_webhook_events (status) WHERE status = 'failed';

-- Bookings: separate columns for the Stripe-side state mirror, distinct from
-- our business `status` column. status stays clean (booking FSM); these two
-- track what Stripe knows about the money.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS dispute_state text
    CHECK (dispute_state IN ('open','won','lost','warning_closed','warning_needs_response')),
  ADD COLUMN IF NOT EXISTS payment_state text
    DEFAULT 'authorized'
    CHECK (payment_state IN ('authorized','action_required','captured','refunded','failed'));
