-- Beam0: track the user's preferred payment method (Stripe pm_id).
-- See specs/0041-saved-payment-methods-ui.md.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_payment_method_id text;
