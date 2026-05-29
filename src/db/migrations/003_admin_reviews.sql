-- Add role to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'customer';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at timestamptz;

-- Reviews table
CREATE TABLE IF NOT EXISTS reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  barber_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id)
);

CREATE INDEX IF NOT EXISTS reviews_barber_id_idx ON reviews(barber_id);

-- Update barber average rating automatically
CREATE OR REPLACE FUNCTION update_barber_rating() RETURNS trigger AS $$
BEGIN
  UPDATE barber_profiles
  SET rating_avg   = (SELECT AVG(rating)::numeric(3,2) FROM reviews WHERE barber_id = NEW.barber_id),
      rating_count = (SELECT COUNT(*)                  FROM reviews WHERE barber_id = NEW.barber_id)
  WHERE user_id = NEW.barber_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_barber_rating ON reviews;
CREATE TRIGGER trg_update_barber_rating
  AFTER INSERT OR UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION update_barber_rating();
