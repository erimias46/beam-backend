-- Beam0: optional tip per booking. See specs/0042-tipping.md.
-- Captured via a second PI on /confirm (tip flows 100% to barber, no app fee).

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS tip_cents int NOT NULL DEFAULT 0
    CHECK (tip_cents >= 0 AND tip_cents <= 100000);

-- Track the tip's Stripe PaymentIntent separately so refund math stays clean.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS tip_payment_intent_id text;
