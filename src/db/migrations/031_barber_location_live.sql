-- Beam0: live barber position during active booking. See specs/0031-live-barber-location-and-eta.md.
--
-- One row per barber (PK) — we overwrite on each ping. No history, no PII trail.
-- ON DELETE CASCADE on booking_id wipes the row when the booking is cancelled.
-- We also explicitly DELETE on transition to in_progress / terminal states.

CREATE TABLE IF NOT EXISTS barber_location_live (
  barber_id   uuid          PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  booking_id  uuid          NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  lat         numeric(10,7) NOT NULL,
  lng         numeric(10,7) NOT NULL,
  heading     int,
  accuracy_m  int,
  updated_at  timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS barber_location_live_booking_idx ON barber_location_live (booking_id);
