-- Fix receipt_token to use hex encoding (URL-safe) instead of base64.
-- Base64 tokens can contain '/' which breaks URL path routing.

ALTER TABLE bookings
  ALTER COLUMN receipt_token SET DEFAULT encode(gen_random_bytes(24), 'hex');

-- Re-encode any existing base64 tokens that contain URL-unsafe characters.
UPDATE bookings
   SET receipt_token = encode(gen_random_bytes(24), 'hex')
 WHERE receipt_token IS NULL
    OR receipt_token LIKE '%/%'
    OR receipt_token LIKE '%+%'
    OR receipt_token LIKE '%=%';
