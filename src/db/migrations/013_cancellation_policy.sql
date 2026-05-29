-- Beam0: timed cancellation fees + no-show tracking. See specs/0013-cancellation-policy.md.
--
-- A customer who cancels in `requested` state pays nothing (no PI yet). After
-- accept (PI authorized), the fee schedule kicks in: tier 1 free, tier 2
-- partial capture, tier 3 partial capture. A barber who accepts but never
-- starts gets watchdog-cancelled and the customer is fully refunded. A barber
-- can flag the customer as no-show after the deadline window, capturing a
-- fraction of the PI.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS cancelled_by text
    CHECK (cancelled_by IN ('customer','barber','admin','system_timeout','system_no_show')),
  ADD COLUMN IF NOT EXISTS cancellation_reason     text,
  ADD COLUMN IF NOT EXISTS cancellation_fee_cents  int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS no_show_party           text
    CHECK (no_show_party IN ('customer','barber'));
