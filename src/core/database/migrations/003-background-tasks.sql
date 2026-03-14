CREATE TABLE background_tasks (
  id              TEXT PRIMARY KEY,
  persona_id      TEXT NOT NULL,
  thread_id       TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  working_dir     TEXT,
  status          TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'completed', 'failed', 'timed_out', 'cancelled')),
  output          TEXT,
  error           TEXT,
  pid             INTEGER,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  timeout_minutes INTEGER NOT NULL DEFAULT 30
);

CREATE INDEX idx_background_tasks_status ON background_tasks(status);
CREATE INDEX idx_background_tasks_thread_created ON background_tasks(thread_id, created_at DESC);
