-- Beam0: legal documents + per-user consent records.
-- See specs/0060-terms-privacy-and-consent.md.

CREATE TABLE IF NOT EXISTS legal_documents (
  id           text        NOT NULL,             -- 'tos' | 'privacy' | 'cookies'
  version      text        NOT NULL,             -- 'v1', 'v2-2026-06-01'
  effective_at timestamptz NOT NULL,
  content_md   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

CREATE INDEX IF NOT EXISTS legal_documents_id_effective_idx
  ON legal_documents (id, effective_at DESC);

CREATE TABLE IF NOT EXISTS user_consents (
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id text        NOT NULL,
  version     text        NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip_address  text,
  user_agent  text,
  PRIMARY KEY (user_id, document_id, version)
);

CREATE INDEX IF NOT EXISTS user_consents_doc_idx ON user_consents (document_id, version);
