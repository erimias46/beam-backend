-- Beam0: two-step completion with photo proof + customer confirm.
-- See specs/0023-completion-proof.md.
--
-- Adds an awaiting_confirmation state between in_progress and completed.
-- Barber /complete now puts the booking in awaiting_confirmation and stages
-- an optional photo. Customer /confirm captures the PI and transitions to
-- completed (then paid via webhook). Customer /dispute releases the hold.
-- A BullMQ delayed job auto-confirms after auto_confirm_minutes (default 10).

ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'awaiting_confirmation' BEFORE 'completed';

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS completion_photo_url       text,
  ADD COLUMN IF NOT EXISTS completion_confirmed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS completion_disputed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS completion_dispute_reason  text;
