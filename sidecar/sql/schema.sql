-- Mirror of pi-durable's committed state, written only by the sidecar, read by Rails.
-- Mirror schema v1. Rails owns it in production: the gem's migration template creates the same tables. This file
-- exists for the sidecar tests and for running the sidecar without Rails.
-- IDs are pi's own IDs (branded integers), so a row here points straight at the harness record.

CREATE TABLE IF NOT EXISTS durable_agent_conversations (
  id                     BIGINT PRIMARY KEY,
  parent_conversation_id BIGINT,
  parent_at_entry_id     BIGINT,
  owner_conversation_id  BIGINT,
  owner_task_id          BIGINT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Entries are immutable: insert once, never update.
CREATE TABLE IF NOT EXISTS durable_agent_entries (
  id              BIGINT PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES durable_agent_conversations(id),
  kind            TEXT   NOT NULL,
  data            JSONB,
  model           JSONB,
  head_entry_id   BIGINT,
  by_task_id      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS durable_agent_entries_conversation_idx ON durable_agent_entries (conversation_id, id);

-- Current value of each built-in document (pi.agent, pi.live, pi.inbox, pi.usage, pi.provider) per conversation.
CREATE TABLE IF NOT EXISTS durable_agent_documents (
  conversation_id BIGINT NOT NULL REFERENCES durable_agent_conversations(id),
  kind            TEXT   NOT NULL,
  body            JSONB  NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, kind)
);

CREATE TABLE IF NOT EXISTS durable_agent_submissions (
  id              BIGINT PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES durable_agent_conversations(id),
  request_id      TEXT,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL,
  entry_id        BIGINT,
  answer_entry_id BIGINT,
  reason          TEXT,
  detail          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS durable_agent_submissions_conversation_idx ON durable_agent_submissions (conversation_id, id);
CREATE INDEX IF NOT EXISTS durable_agent_submissions_request_idx ON durable_agent_submissions (request_id);

-- Failures the harness reports without failing the calling operation: faulted or parked tasks, hook errors, etc.
CREATE TABLE IF NOT EXISTS durable_agent_reports (
  id              BIGSERIAL PRIMARY KEY,
  type            TEXT NOT NULL,
  conversation_id BIGINT,
  task_id         BIGINT,
  task_kind       TEXT,
  extension       TEXT,
  message         TEXT NOT NULL,
  info            JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS durable_agent_reports_conversation_idx ON durable_agent_reports (conversation_id, id);

-- Provider credentials (API keys, OAuth tokens from Sign in with ChatGPT). Written only by the sidecar through
-- pi-ai's CredentialStore. Rails never reads this table; it asks the sidecar GET /auth for connection status.
CREATE TABLE IF NOT EXISTS durable_agent_credentials (
  provider_id TEXT PRIMARY KEY,
  credential  JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Installation-level settings: the stable device id OpenAI identifies this agent host by, and schema_version.
CREATE TABLE IF NOT EXISTS durable_agent_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
