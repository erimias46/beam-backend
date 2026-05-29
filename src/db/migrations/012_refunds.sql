-- Beam0: first-class refund tracking. See specs/0012-refunds-flow.md.
--
-- The pre-spec refund path was a single admin endpoint that flipped bookings
-- to 'cancelled' and called stripe.refunds.create. Problems: no partial refund,
-- no reason capture, no customer self-service, no idempotency, status-flip
-- collision with cancellation. This migration introduces a refunds table with
-- a trigger that maintains bookings.refunded_cents as a derived sum.

CREATE TABLE IF NOT EXISTS refunds (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        uuid        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  stripe_refund_id  text        UNIQUE,
  amount_cents      int         NOT NULL CHECK (amount_cents > 0),
  reason            text        NOT NULL CHECK (reason IN (
    'requested_by_customer','duplicate','fraudulent','barber_no_show',
    'service_incomplete','quality_issue','admin_other'
  )),
  initiated_by      uuid        REFERENCES users(id),
  initiated_by_role text        NOT NULL CHECK (initiated_by_role IN ('customer','admin','system')),
  notes             text,
  status            text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','succeeded','failed','cancelled')),
  stripe_error      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  succeeded_at      timestamptz
);

CREATE INDEX IF NOT EXISTS refunds_booking_idx ON refunds (booking_id);
CREATE INDEX IF NOT EXISTS refunds_status_idx  ON refunds (status);

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS refunded_cents int NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION recompute_booking_refunded()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE bookings
     SET refunded_cents = COALESCE((
       SELECT SUM(amount_cents) FROM refunds
        WHERE booking_id = COALESCE(NEW.booking_id, OLD.booking_id)
          AND status = 'succeeded'
     ), 0)
   WHERE id = COALESCE(NEW.booking_id, OLD.booking_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS refunds_recompute ON refunds;
CREATE TRIGGER refunds_recompute
  AFTER INSERT OR UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION recompute_booking_refunded();
