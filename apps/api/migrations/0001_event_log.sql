-- Event log tables (schema only; the adapter that writes them comes with the run domain).
-- `threads` is a projection of the thread.* events, updated in the same batch as the append.
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  parent_thread_id TEXT REFERENCES threads (id),
  kind TEXT NOT NULL,
  task TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX threads_run ON threads (run_id);

-- `id` comes from the client so a retried POST is a no-op; `seq` is allocated by the
-- insert, unique per run, and is the stream cursor.
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, seq)
);
CREATE INDEX events_thread ON events (thread_id, seq);

-- Pi's message history, append-only: one row per message, read back in idx order.
CREATE TABLE pi_messages (
  thread_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (thread_id, idx)
);
