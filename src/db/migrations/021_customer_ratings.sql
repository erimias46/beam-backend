-- Beam0: barbers rate customers. See specs/0021-two-way-ratings.md.
--
-- One rating per booking (UNIQUE on booking_id). Tags are loose — frontend
-- offers a fixed checklist but the DB allows any text. Notes are private to
-- the rating barber + admins; customers see only their own aggregate.

CREATE TABLE IF NOT EXISTS customer_ratings (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid        REFERENCES bookings(id) ON DELETE CASCADE UNIQUE,
  barber_id   uuid        REFERENCES users(id),
  customer_id uuid        REFERENCES users(id),
  rating      int         CHECK (rating BETWEEN 1 AND 5) NOT NULL,
  tags        text[]      DEFAULT '{}',
  notes       text,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_ratings_customer_idx ON customer_ratings(customer_id);
CREATE INDEX IF NOT EXISTS customer_ratings_barber_idx   ON customer_ratings(barber_id);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS customer_rating_avg   numeric(3,2),
  ADD COLUMN IF NOT EXISTS customer_rating_count int DEFAULT 0;

CREATE OR REPLACE FUNCTION update_customer_rating()
RETURNS TRIGGER AS $$
DECLARE
  target_id uuid;
BEGIN
  target_id := COALESCE(NEW.customer_id, OLD.customer_id);
  UPDATE users
     SET customer_rating_count = (SELECT COUNT(*) FROM customer_ratings WHERE customer_id = target_id),
         customer_rating_avg   = (SELECT AVG(rating)::numeric(3,2) FROM customer_ratings WHERE customer_id = target_id)
   WHERE id = target_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_ratings_recompute ON customer_ratings;
CREATE TRIGGER customer_ratings_recompute
  AFTER INSERT OR UPDATE OR DELETE ON customer_ratings
  FOR EACH ROW EXECUTE FUNCTION update_customer_rating();

-- Add to settings: rating window in hours (default 24).
