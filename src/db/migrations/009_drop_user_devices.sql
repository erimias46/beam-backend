-- Beam0: remove legacy FCM table.
-- Active push path is push_subscriptions (migration 007). user_devices was
-- created in 001 for an FCM transport that we never shipped — no code reads
-- or writes it today. Dropping it kills the "which one is real?" confusion.

DROP TABLE IF EXISTS user_devices;
