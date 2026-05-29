-- Beam0: barber favorites. See specs/0044-rebook-and-favorites.md.

CREATE TABLE IF NOT EXISTS barber_favorites (
  customer_id uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  barber_id   uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, barber_id),
  CHECK (customer_id <> barber_id)
);

CREATE INDEX IF NOT EXISTS barber_favorites_barber_idx ON barber_favorites(barber_id);
