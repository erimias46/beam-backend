-- Beam0: city SEO landing pages. See specs/0072-city-seo-landing-pages.md.

CREATE TABLE IF NOT EXISTS service_cities (
  slug             text        PRIMARY KEY,
  name             text        NOT NULL,
  state            text,
  country          text        NOT NULL DEFAULT 'US',
  lat              numeric(10,7) NOT NULL,
  lng              numeric(10,7) NOT NULL,
  bounds_polygon   jsonb,
  hero_image_url   text,
  copy_md          text,
  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS service_cities_active_idx ON service_cities (is_active);
