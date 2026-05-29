-- Beam0: refresh tokens + per-session revocation. See specs/0074-refresh-tokens-and-session-management.md.
--
-- Access tokens stay JWT (15-min TTL going forward). Refresh tokens are opaque
-- random strings (sha256-hashed at rest), 90-day TTL, individually revocable.
-- Each refresh ROTATES the token; reusing a revoked refresh nukes all the
-- user's sessions (compromise signal).

CREATE TABLE IF NOT EXISTS sessions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text        NOT NULL UNIQUE,
  device_label       text,
  ip_address         text,
  user_agent         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz
);

CREATE INDEX IF NOT EXISTS sessions_user_idx
  ON sessions (user_id, revoked_at, expires_at);
