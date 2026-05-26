-- Switch primary login identifier from phone to email
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email) WHERE email IS NOT NULL;
