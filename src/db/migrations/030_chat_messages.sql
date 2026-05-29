-- Beam0: in-app chat scoped to a booking. See specs/0030-in-app-chat.md.
--
-- Strictly 1:1 customer ↔ barber, lifecycle bounded by the booking. We use
-- the existing SSE pipeline to push 'message_received' events to the receiver
-- and Web Push for offline delivery. Admin can read the full transcript for
-- dispute investigation.

CREATE TABLE IF NOT EXISTS chat_messages (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  sender_id    uuid        NOT NULL REFERENCES users(id),
  body         text        NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  sent_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS chat_messages_booking_sent_idx
  ON chat_messages (booking_id, sent_at);

CREATE INDEX IF NOT EXISTS chat_messages_unread_idx
  ON chat_messages (booking_id) WHERE delivered_at IS NULL;
