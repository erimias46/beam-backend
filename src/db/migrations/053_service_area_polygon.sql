-- Beam0: barber service-area polygon. See specs/0053-service-area-polygon.md.
-- jsonb shape: [{"lat":...,"lng":...}, ...] — 3..50 vertices. Takes priority
-- over service_radius_km in matchmaking when set.

ALTER TABLE barber_profiles
  ADD COLUMN IF NOT EXISTS service_polygon jsonb;
