-- Beam0: soft-delete users with financial history (anonymize), hard-delete
-- others. See specs/0061-account-deletion-and-data-export.md.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at      timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_reason  text;

-- Partial index to keep common queries fast (exclude deleted from listing).
CREATE INDEX IF NOT EXISTS users_active_idx ON users(id) WHERE deleted_at IS NULL;
