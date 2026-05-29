-- Beam0: track when a user dismissed/accepted the in-app push permission prompt.
-- See specs/0032-push-permission-ux.md.
--
-- We use these timestamps to decide whether to re-show the prompt later
-- (e.g. 30 days after a "maybe later" dismissal). Browser-native permission
-- can never be re-asked once denied, so this is purely about our own UX gate.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS push_prompt_dismissed_at timestamptz,
  ADD COLUMN IF NOT EXISTS push_prompt_accepted_at  timestamptz;
