-- User notification preferences
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_notifications boolean NOT NULL DEFAULT true;

-- Index for efficient lookup when sending emails
CREATE INDEX IF NOT EXISTS users_email_notifications_idx
  ON users(email_notifications) WHERE email_notifications = true;
