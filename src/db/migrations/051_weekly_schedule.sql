-- Beam0: barber weekly schedule + vacation mode + timezone.
-- See specs/0051-weekly-schedule-and-vacation.md.
--
-- One row per (barber, day_of_week, start_minute) — allowing multiple windows
-- per day (e.g. 10-13 + 14-19 with a lunch break).

CREATE TABLE IF NOT EXISTS barber_weekly_schedule (
  barber_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week  int  NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0 = Sunday
  start_minute int  NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   int  NOT NULL CHECK (end_minute   BETWEEN 1 AND 1440 AND end_minute > start_minute),
  PRIMARY KEY (barber_id, day_of_week, start_minute)
);

ALTER TABLE barber_profiles
  ADD COLUMN IF NOT EXISTS vacation_until timestamptz,
  ADD COLUMN IF NOT EXISTS timezone       text NOT NULL DEFAULT 'America/New_York';
