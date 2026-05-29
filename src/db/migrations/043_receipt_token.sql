-- Beam0: shareable receipt tokens. See specs/0043-receipts-and-invoices.md.
--
-- Opaque ~32-char base64 token. Anyone with the token can view the hosted
-- receipt page — Stripe-style. Backfilled to all existing rows via DEFAULT.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS receipt_token text;

-- Backfill existing rows (column added without default for existing nulls).
UPDATE bookings SET receipt_token = encode(gen_random_bytes(24), 'base64')
 WHERE receipt_token IS NULL;

-- Now lock it in for new rows.
ALTER TABLE bookings
  ALTER COLUMN receipt_token SET DEFAULT encode(gen_random_bytes(24), 'base64');

CREATE UNIQUE INDEX IF NOT EXISTS bookings_receipt_token_idx ON bookings(receipt_token);
