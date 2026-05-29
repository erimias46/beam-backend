-- Beam0: store client-supplied idempotency keys so retried requests return the
-- original response. See specs/0010-idempotency-keys.md.
--
-- Keys are scoped per (user_id, key). A retry with the same key but a different
-- body hash returns 409. Rows older than 24h are cleaned by the BullMQ job
-- registered in services/queue.js. Stripe-side idempotency (deterministic keys
-- like 'booking_accept_<id>') is wired separately in the route code — this
-- table only protects the HTTP layer.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key            text        NOT NULL,
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint       text        NOT NULL,
  request_hash   text        NOT NULL,
  status_code    int,
  response_body  jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_created_at_idx
  ON idempotency_keys (created_at);
