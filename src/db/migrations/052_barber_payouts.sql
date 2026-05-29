-- Beam0: barber payouts ledger. See specs/0052-earnings-export-and-stripe-express.md.
-- Populated by payout.* webhook events reserved in spec 0011.

CREATE TABLE IF NOT EXISTS barber_payouts (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  barber_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_payout_id text        UNIQUE NOT NULL,
  amount_cents     int         NOT NULL,
  currency         text        NOT NULL DEFAULT 'usd',
  status           text        NOT NULL CHECK (status IN ('pending','in_transit','paid','failed','cancelled')),
  arrival_date     date,
  failure_message  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS barber_payouts_barber_idx ON barber_payouts(barber_id, created_at DESC);
