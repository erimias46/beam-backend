-- Beam0: saved addresses. See specs/0040-saved-addresses.md.

CREATE TABLE IF NOT EXISTS saved_addresses (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       text          NOT NULL,
  address     text          NOT NULL,
  lat         numeric(10,7),
  lng         numeric(10,7),
  is_default  boolean       NOT NULL DEFAULT false,
  created_at  timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saved_addresses_user_idx ON saved_addresses(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS saved_addresses_one_default_per_user
  ON saved_addresses (user_id) WHERE is_default = true;
