-- Beam0: promos + referrals + credit ledger. See specs/0070-promo-and-referral-codes.md.
--
-- promos is the catalog. Each row is type=percent|amount|referral. Redemption
-- count is incremented atomically when used. Per-user-limit guarded via
-- promo_redemptions table count. Credits are a separate ledger (referral
-- rewards, refund-to-credit, admin grants) that bookings can spend.

CREATE TABLE IF NOT EXISTS promos (
  code               text        PRIMARY KEY,
  type               text        NOT NULL CHECK (type IN ('percent','amount','referral')),
  percent_off        int         CHECK (percent_off IS NULL OR (percent_off BETWEEN 1 AND 100)),
  amount_off_cents   int         CHECK (amount_off_cents IS NULL OR amount_off_cents > 0),
  max_discount_cents int,
  min_booking_cents  int,
  redemptions_max    int,
  redemptions_used   int         NOT NULL DEFAULT 0,
  per_user_limit     int         NOT NULL DEFAULT 1,
  valid_from         timestamptz,
  valid_until        timestamptz,
  first_booking_only boolean     NOT NULL DEFAULT false,
  referral_owner_id  uuid        REFERENCES users(id) ON DELETE SET NULL,
  is_active          boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS promos_referral_owner_idx
  ON promos (referral_owner_id) WHERE referral_owner_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code     text        NOT NULL REFERENCES promos(code),
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id     uuid        REFERENCES bookings(id),
  discount_cents int         NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS promo_redemptions_user_code_idx ON promo_redemptions(user_id, promo_code);

CREATE TABLE IF NOT EXISTS user_credits (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents        int         NOT NULL,         -- + credit, − debit
  source              text        NOT NULL CHECK (source IN ('referral','refund_credit','admin_grant','redemption')),
  source_ref          text,
  balance_after_cents int         NOT NULL,
  expires_at          timestamptz,                  -- spec resolution: 12-month default
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_credits_user_idx ON user_credits(user_id, created_at DESC);

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS promo_code           text,
  ADD COLUMN IF NOT EXISTS promo_discount_cents int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credit_applied_cents int NOT NULL DEFAULT 0;
