-- Beam0: per-user token invalidation fence (spec 0080).
-- When a user is suspended or their role is changed, set token_valid_after = now().
-- requireAuth rejects any JWT with iat < token_valid_after, revoking old tokens.

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_valid_after timestamptz;

CREATE INDEX IF NOT EXISTS users_token_valid_after_idx
  ON users(id, token_valid_after) WHERE token_valid_after IS NOT NULL;
