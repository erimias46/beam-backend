-- Beam0: in-app report + block. See specs/0022-report-and-block-user.md.
--
-- Two tables. user_reports lands in an admin queue with full context.
-- user_blocks is a pairwise relationship that prevents future bookings
-- in either direction.

CREATE TABLE IF NOT EXISTS user_reports (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  uuid        NOT NULL REFERENCES users(id),
  reported_id  uuid        NOT NULL REFERENCES users(id),
  booking_id   uuid        REFERENCES bookings(id),
  category     text        NOT NULL CHECK (category IN
    ('harassment','no_show','unsafe_behavior','payment_issue','impersonation','other')),
  description  text        NOT NULL,
  status       text        NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','reviewing','resolved','dismissed')),
  resolution   text,
  resolved_by  uuid        REFERENCES users(id),
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_reports_status_idx   ON user_reports (status, created_at);
CREATE INDEX IF NOT EXISTS user_reports_reported_idx ON user_reports (reported_id);

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id   uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id   uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx ON user_blocks (blocked_id);
