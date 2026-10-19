-- durable_agent schema v2 for SQLite: a hand rendering of the gem's install migration
-- (lib/generators/durable_agent/install/templates/create_durable_agent_tables.rb.tt) for the sidecar tests.
-- Rails owns the real schema; test/lib/durable_agent/sidecar_schema_test.rb runs both against fresh databases and
-- compares tables, column types, nullability and defaults, and index definitions.
-- The first nine tables are pi-durable 1.3.0's schema (version 1) under the durable_agent_ prefix, minus STRICT
-- and the json_valid checks. No rows: the sidecar seeds the singletons at boot.

CREATE TABLE IF NOT EXISTS durable_agent_durable_schema (
  singleton integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  version integer NOT NULL
);

CREATE TABLE IF NOT EXISTS durable_agent_durable_metadata (
  singleton integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  next_id text NOT NULL,
  next_seq bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS durable_agent_record_ids (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  record_type text NOT NULL
);

CREATE TABLE IF NOT EXISTS durable_agent_conversations (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  owner_conversation_id bigint,
  owner_task_id bigint,
  record text NOT NULL,
  created_at datetime(6) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS durable_agent_conversations_by_owner_conversation ON durable_agent_conversations (owner_conversation_id, id);
CREATE INDEX IF NOT EXISTS durable_agent_conversations_by_owner_task ON durable_agent_conversations (owner_task_id, id);

CREATE TABLE IF NOT EXISTS durable_agent_entries (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  conversation_id bigint NOT NULL,
  head bigint,
  commit_seq bigint NOT NULL,
  record text NOT NULL,
  created_at datetime(6) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS durable_agent_entries_by_conversation ON durable_agent_entries (conversation_id, id DESC);
CREATE INDEX IF NOT EXISTS durable_agent_entry_heads_by_conversation ON durable_agent_entries (conversation_id, id DESC) WHERE head IS NOT NULL;

CREATE TABLE IF NOT EXISTS durable_agent_tasks (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  conversation_id bigint NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  abort_requested integer NOT NULL,
  background integer NOT NULL,
  record text NOT NULL
);
CREATE INDEX IF NOT EXISTS durable_agent_tasks_by_status ON durable_agent_tasks (status, id);
CREATE INDEX IF NOT EXISTS durable_agent_tasks_by_conversation ON durable_agent_tasks (conversation_id, id);
CREATE INDEX IF NOT EXISTS durable_agent_tasks_by_kind ON durable_agent_tasks (kind, id);
CREATE INDEX IF NOT EXISTS durable_agent_tasks_by_abort_requested ON durable_agent_tasks (abort_requested, id);
CREATE INDEX IF NOT EXISTS durable_agent_tasks_by_background ON durable_agent_tasks (background, id);

CREATE TABLE IF NOT EXISTS durable_agent_submissions (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  conversation_id bigint NOT NULL,
  request_id text,
  status text NOT NULL,
  record text NOT NULL,
  created_at datetime(6) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS durable_agent_submissions_by_request ON durable_agent_submissions (conversation_id, request_id);
CREATE INDEX IF NOT EXISTS durable_agent_submissions_by_conversation ON durable_agent_submissions (conversation_id, id);
CREATE INDEX IF NOT EXISTS durable_agent_submissions_by_status ON durable_agent_submissions (status, id);

CREATE TABLE IF NOT EXISTS durable_agent_documents (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  kind text NOT NULL,
  family integer NOT NULL,
  key_value text NOT NULL,
  scope_kind text NOT NULL,
  owner_id bigint NOT NULL,
  created_at bigint NOT NULL,
  retired_at bigint,
  record text NOT NULL
);
CREATE INDEX IF NOT EXISTS durable_agent_documents_by_address ON durable_agent_documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at);
CREATE INDEX IF NOT EXISTS durable_agent_documents_by_scope ON durable_agent_documents (scope_kind, owner_id, id);
CREATE INDEX IF NOT EXISTS durable_agent_documents_by_scope_kind ON durable_agent_documents (scope_kind, owner_id, kind, id);

CREATE TABLE IF NOT EXISTS durable_agent_document_revisions (
  document_id bigint NOT NULL,
  seq bigint NOT NULL,
  kind text NOT NULL,
  version bigint NOT NULL,
  content text NOT NULL,
  PRIMARY KEY (document_id, seq)
);
CREATE INDEX IF NOT EXISTS durable_agent_document_revisions_by_kind ON durable_agent_document_revisions (document_id, kind, seq DESC);

CREATE TABLE IF NOT EXISTS durable_agent_reports (
  id integer NOT NULL PRIMARY KEY AUTOINCREMENT,
  type text NOT NULL,
  conversation_id bigint,
  task_id bigint,
  task_kind text,
  extension text,
  message text NOT NULL,
  info text NOT NULL,
  created_at datetime(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS index_durable_agent_reports_on_conversation_id_and_id ON durable_agent_reports (conversation_id, id);

CREATE TABLE IF NOT EXISTS durable_agent_credentials (
  provider_id text NOT NULL PRIMARY KEY,
  credential text NOT NULL,
  updated_at datetime(6) NOT NULL
);

CREATE TABLE IF NOT EXISTS durable_agent_settings (
  key text NOT NULL PRIMARY KEY,
  value text NOT NULL,
  updated_at datetime(6) NOT NULL
);
