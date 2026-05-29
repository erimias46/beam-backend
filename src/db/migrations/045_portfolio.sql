-- Beam0: barber portfolio gallery. See specs/0045-search-filters-and-portfolio.md.
-- Cap of 20 per barber enforced in app code, not DB constraint.

CREATE TABLE IF NOT EXISTS barber_portfolio (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  barber_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_url     text        NOT NULL,
  caption       text,
  display_order int         NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS barber_portfolio_barber_order_idx
  ON barber_portfolio (barber_id, display_order);
