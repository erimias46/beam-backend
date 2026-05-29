-- Barber base location for proximity search.
-- Customers see barbers nearest to them first; an optional radius hides
-- barbers who don't serve the customer's area.
ALTER TABLE barber_profiles
  ADD COLUMN IF NOT EXISTS lat               numeric(10,7),
  ADD COLUMN IF NOT EXISTS lng               numeric(10,7),
  ADD COLUMN IF NOT EXISTS base_address      text,
  ADD COLUMN IF NOT EXISTS service_radius_km numeric(6,2) DEFAULT 25;

CREATE INDEX IF NOT EXISTS barber_profiles_geo_idx ON barber_profiles(lat, lng);
