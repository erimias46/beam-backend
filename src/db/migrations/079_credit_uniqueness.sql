-- Beam0: credit ledger uniqueness + non-negative balance guard (spec 0084).

ALTER TABLE user_credits
  ADD COLUMN IF NOT EXISTS source_ref text;

-- Prevent double-awarding the same credit event (e.g. duplicate referral awards)
CREATE UNIQUE INDEX IF NOT EXISTS user_credits_source_ref_idx
  ON user_credits(user_id, source, source_ref)
  WHERE source_ref IS NOT NULL;

-- Guard against negative balances (enforced by app locking, this is DB safety net)
DO $$
BEGIN
  ALTER TABLE user_credits
    ADD CONSTRAINT user_credits_balance_non_negative
    CHECK (balance_after_cents >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
