-- Beam0: lightweight email campaign tracking. See specs/0073-win-back-emails.md.

CREATE TABLE IF NOT EXISTS email_campaigns (
  id           text        PRIMARY KEY,                    -- 'winback_60d', etc.
  description  text,
  template_key text        NOT NULL,
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_sends (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id     text        NOT NULL REFERENCES email_campaigns(id),
  sent_at         timestamptz NOT NULL DEFAULT now(),
  opened_at       timestamptz,
  clicked_at      timestamptz,
  unsubscribed_at timestamptz,
  UNIQUE (user_id, campaign_id)                            -- at most once per (user, campaign)
);

CREATE INDEX IF NOT EXISTS email_sends_campaign_idx ON email_sends (campaign_id, sent_at DESC);

-- Seed the default campaigns.
INSERT INTO email_campaigns (id, description, template_key) VALUES
  ('winback_60d',                'Lapsed customer >60 days no booking',    'winback_60d'),
  ('first_booking_followup_24h', '24h after first paid booking: review',   'first_booking_followup'),
  ('incomplete_signup_3d',       'Signed up, no first booking after 3d',   'incomplete_signup_3d')
ON CONFLICT (id) DO NOTHING;
