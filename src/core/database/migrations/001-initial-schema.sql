-- Migration 001: Initial Schema
-- Applied via: talonctl migrate

-- ============================================================
-- CHANNELS
-- ============================================================
CREATE TABLE channels (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,                    -- 'telegram', 'whatsapp', 'slack', 'email', 'discord'
  name        TEXT NOT NULL UNIQUE,
  config      TEXT NOT NULL DEFAULT '{}',       -- JSON: channel-specific config
  credentials_ref TEXT,                         -- reference to secret (e.g., 'secrets:telegram_bot_token')
  enabled     INTEGER NOT NULL DEFAULT 1,       -- boolean: 0 or 1
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_channels_type ON channels(type);
CREATE INDEX idx_channels_enabled ON channels(enabled);

-- ============================================================
-- PERSONAS
-- ============================================================
CREATE TABLE personas (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  model               TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  system_prompt_file  TEXT,                     -- relative path to system prompt markdown
  skills              TEXT NOT NULL DEFAULT '[]',  -- JSON array of skill names
  capabilities        TEXT NOT NULL DEFAULT '{}',  -- JSON: { allow: [...], requireApproval: [...] }
  mounts              TEXT NOT NULL DEFAULT '[]',  -- JSON array of mount configs
  max_concurrent      INTEGER,                  -- per-persona container limit (null = global limit)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- ============================================================
-- BINDINGS
-- ============================================================
CREATE TABLE bindings (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  thread_id   TEXT,                             -- null = default for channel
  persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  is_default  INTEGER NOT NULL DEFAULT 0,       -- boolean: default persona for channel
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(channel_id, thread_id)
);

CREATE INDEX idx_bindings_channel ON bindings(channel_id);
CREATE INDEX idx_bindings_persona ON bindings(persona_id);
CREATE INDEX idx_bindings_lookup ON bindings(channel_id, thread_id);

-- ============================================================
-- THREADS
-- ============================================================
CREATE TABLE threads (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,                    -- channel-specific thread identifier
  metadata    TEXT NOT NULL DEFAULT '{}',       -- JSON: channel-specific metadata
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(channel_id, external_id)
);

CREATE INDEX idx_threads_channel ON threads(channel_id);
CREATE INDEX idx_threads_external ON threads(channel_id, external_id);

-- ============================================================
-- MESSAGES
-- ============================================================
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  content         TEXT NOT NULL,                -- JSON: normalized message content
  idempotency_key TEXT NOT NULL,                -- caller provides channel-scoped key for dedup
  provider_id     TEXT,                         -- original provider message ID
  run_id          TEXT,                         -- which run produced this (outbound only)
  created_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_messages_idempotency ON messages(idempotency_key);
CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);
CREATE INDEX idx_messages_run ON messages(run_id);

-- ============================================================
-- QUEUE ITEMS
-- ============================================================
CREATE TABLE queue_items (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id    TEXT REFERENCES messages(id),
  type          TEXT NOT NULL DEFAULT 'message', -- 'message', 'schedule', 'collaboration'
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'claimed', 'processing', 'completed', 'failed', 'dead_letter')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  next_retry_at INTEGER,                        -- null when not retrying
  error         TEXT,                           -- last error message
  payload       TEXT NOT NULL DEFAULT '{}',     -- JSON: type-specific payload
  claimed_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_queue_pending ON queue_items(status, next_retry_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX idx_queue_thread ON queue_items(thread_id, status, created_at);
CREATE INDEX idx_queue_claimed ON queue_items(status, claimed_at)
  WHERE status = 'claimed';

-- ============================================================
-- RUNS
-- ============================================================
CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  persona_id    TEXT NOT NULL REFERENCES personas(id),
  sandbox_id    TEXT,                           -- Docker container ID
  session_id    TEXT,                           -- SDK session ID for resumption
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  parent_run_id TEXT REFERENCES runs(id),       -- for child runs (multi-agent)
  queue_item_id TEXT REFERENCES queue_items(id),
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0.0,
  error         TEXT,
  started_at    INTEGER,
  ended_at      INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_runs_thread ON runs(thread_id, created_at);
CREATE INDEX idx_runs_persona ON runs(persona_id);
CREATE INDEX idx_runs_parent ON runs(parent_run_id);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_session ON runs(session_id);

-- ============================================================
-- SCHEDULES
-- ============================================================
CREATE TABLE schedules (
  id          TEXT PRIMARY KEY,
  persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  thread_id   TEXT REFERENCES threads(id),      -- null = create new thread
  type        TEXT NOT NULL CHECK (type IN ('cron', 'interval', 'one_shot', 'event')),
  expression  TEXT NOT NULL,                    -- cron expr, interval ms, ISO datetime, or event name
  payload     TEXT NOT NULL DEFAULT '{}',       -- JSON: message/task payload
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_schedules_next ON schedules(enabled, next_run_at)
  WHERE enabled = 1;
CREATE INDEX idx_schedules_persona ON schedules(persona_id);

-- ============================================================
-- MEMORY ITEMS
-- ============================================================
CREATE TABLE memory_items (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('fact', 'summary', 'note', 'embedding_ref')),
  content       TEXT NOT NULL,
  embedding_ref TEXT,                           -- pointer to vector store (optional)
  metadata      TEXT NOT NULL DEFAULT '{}',     -- JSON: additional metadata
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_memory_thread ON memory_items(thread_id, type);

-- ============================================================
-- ARTIFACTS
-- ============================================================
CREATE TABLE artifacts (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,                    -- relative path within artifacts dir
  mime_type   TEXT,
  size        INTEGER NOT NULL DEFAULT 0,       -- bytes
  checksum    TEXT,                             -- SHA-256
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_artifacts_run ON artifacts(run_id);
CREATE INDEX idx_artifacts_thread ON artifacts(thread_id);

-- ============================================================
-- AUDIT LOG
-- ============================================================
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  run_id      TEXT,
  thread_id   TEXT,
  persona_id  TEXT,
  action      TEXT NOT NULL,                    -- e.g., 'tool.execute', 'channel.send', 'approval.grant'
  tool        TEXT,                             -- tool name if applicable
  request_id  TEXT,                             -- tool request ID for correlation
  details     TEXT NOT NULL DEFAULT '{}',       -- JSON: action-specific details
  created_at  INTEGER NOT NULL
);

-- Append-only: no UPDATE or DELETE triggers allowed
CREATE INDEX idx_audit_run ON audit_log(run_id);
CREATE INDEX idx_audit_thread ON audit_log(thread_id);
CREATE INDEX idx_audit_action ON audit_log(action, created_at);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- ============================================================
-- TOOL RESULTS (idempotent cache)
-- ============================================================
CREATE TABLE tool_results (
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  request_id  TEXT NOT NULL,
  tool        TEXT NOT NULL,
  result      TEXT NOT NULL,                    -- JSON: tool execution result
  status      TEXT NOT NULL CHECK (status IN ('success', 'error', 'timeout')),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (run_id, request_id)
);
