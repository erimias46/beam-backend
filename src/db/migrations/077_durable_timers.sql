-- Beam0: DB-backed timer columns for durable auto-cancel/confirm fallback (spec 0082).
-- BullMQ jobs remain the primary mechanism; the DB columns are the fallback sweep
-- so money events survive Redis loss.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS auto_cancel_at  timestamptz,
  ADD COLUMN IF NOT EXISTS auto_confirm_at timestamptz;

CREATE INDEX IF NOT EXISTS bookings_auto_cancel_idx
  ON bookings(auto_cancel_at)
  WHERE auto_cancel_at IS NOT NULL AND status = 'requested';

CREATE INDEX IF NOT EXISTS bookings_auto_confirm_idx
  ON bookings(auto_confirm_at)
  WHERE auto_confirm_at IS NOT NULL AND status = 'awaiting_confirmation';
