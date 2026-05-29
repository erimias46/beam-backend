-- Beam0: heartbeat for auto-offline sweep. See specs/0050-online-offline-toggle.md.

ALTER TABLE barber_profiles
  ADD COLUMN IF NOT EXISTS last_online_ping_at timestamptz;

CREATE INDEX IF NOT EXISTS barber_profiles_last_ping_idx
  ON barber_profiles (last_online_ping_at) WHERE is_available = true;
