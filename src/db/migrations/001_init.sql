-- Beam0 initial schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Booking status enum
CREATE TYPE booking_status AS ENUM (
  'requested',
  'accepted',
  'declined',
  'in_progress',
  'completed',
  'cancelled',
  'paid'
);

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  phone              text UNIQUE NOT NULL,
  email              text,
  role               text CHECK (role IN ('customer', 'barber', 'facility')) NOT NULL,
  stripe_customer_id text,
  stripe_account_id  text,
  created_at         timestamptz DEFAULT now()
);

-- Barber profiles
CREATE TABLE IF NOT EXISTS barber_profiles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  bio               text,
  years_experience  int DEFAULT 0,
  services          jsonb DEFAULT '[]'::jsonb,
  profile_photo_url text,
  is_available      boolean DEFAULT true,
  rating_avg        numeric(3,2) DEFAULT 0,
  rating_count      int DEFAULT 0,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

-- Bookings
CREATE TABLE IF NOT EXISTS bookings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id               uuid REFERENCES users(id),
  barber_id                 uuid REFERENCES users(id),
  address                   text NOT NULL,
  lat                       numeric(10,7),
  lng                       numeric(10,7),
  scheduled_at              timestamptz NOT NULL,
  service_type              text NOT NULL,
  price_cents               int NOT NULL CHECK (price_cents > 0),
  status                    booking_status DEFAULT 'requested',
  stripe_payment_intent_id  text,
  notes                     text,
  created_at                timestamptz DEFAULT now(),
  updated_at                timestamptz DEFAULT now()
);

-- User devices (FCM tokens)
CREATE TABLE IF NOT EXISTS user_devices (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  fcm_token  text NOT NULL,
  platform   text CHECK (platform IN ('web', 'ios', 'android')) NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, fcm_token)
);

-- Reviews
CREATE TABLE IF NOT EXISTS reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid REFERENCES bookings(id) UNIQUE,
  reviewer_id uuid REFERENCES users(id),
  barber_id   uuid REFERENCES users(id),
  rating      int CHECK (rating BETWEEN 1 AND 5) NOT NULL,
  comment     text,
  created_at  timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS bookings_customer_id_idx ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS bookings_barber_id_idx ON bookings(barber_id);
CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings(status);
CREATE INDEX IF NOT EXISTS bookings_scheduled_at_idx ON bookings(scheduled_at);
CREATE INDEX IF NOT EXISTS barber_profiles_user_id_idx ON barber_profiles(user_id);
CREATE INDEX IF NOT EXISTS barber_profiles_available_idx ON barber_profiles(is_available);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER barber_profiles_updated_at
  BEFORE UPDATE ON barber_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
