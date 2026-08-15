/** SQL schema for the SQLite store. */
export const SCHEMA_VERSION = 3;

const AGENT_CALLS_SQL = `
CREATE TABLE IF NOT EXISTS agent_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  step_id TEXT,                     -- NULL when called outside any step
  provider TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,             -- ok | failed | cancelled | timed_out
  input_tokens INTEGER,             -- disjoint fields: input excludes cache reads/writes
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd REAL,                    -- provider-reported only, never computed
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_calls_run ON agent_calls(run_id);
`;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  trigger_kind TEXT,
  status TEXT NOT NULL,
  event_json TEXT NOT NULL,         -- the normalized event (enables replay)
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT,
  error_code TEXT,
  error_details_json TEXT,
  provenance_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_workflow ON runs(workflow_name);

CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  output_json TEXT,
  error TEXT,
  error_code TEXT,
  error_details_json TEXT,
  logs TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id);

CREATE TABLE IF NOT EXISTS run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES runs(id),
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,             -- e.g. linear, jira, schedule, manual
  type TEXT NOT NULL,
  scope_id TEXT,
  workflow_name TEXT,
  dedupe_key TEXT,                  -- connector dedup
  payload_json TEXT NOT NULL,
  raw_json TEXT,
  occurred_at INTEGER,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_dedupe ON events(dedupe_key);

CREATE TABLE IF NOT EXISTS kv (
  namespace TEXT NOT NULL,          -- trigger cursors, last-seen ids, schema version
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, key)
);
${AGENT_CALLS_SQL}`;

/**
 * Versioned migrations applied to databases created at an older SCHEMA_VERSION.
 * Keyed by the version they migrate *to*; run in order from stored+1 up to
 * SCHEMA_VERSION. New-table migrations use IF NOT EXISTS so they stay
 * idempotent with SCHEMA_SQL; ALTER-based migrations must not (they'd fail on
 * re-run, which the version gate prevents).
 */
export const MIGRATIONS: Record<number, string> = {
  2: AGENT_CALLS_SQL,
  3: `
    ALTER TABLE runs ADD COLUMN error_code TEXT;
    ALTER TABLE runs ADD COLUMN error_details_json TEXT;
    ALTER TABLE runs ADD COLUMN provenance_json TEXT;
    ALTER TABLE run_steps ADD COLUMN error_code TEXT;
    ALTER TABLE run_steps ADD COLUMN error_details_json TEXT;
    UPDATE runs SET status = 'failed' WHERE status = 'error';
    UPDATE run_steps SET status = 'failed' WHERE status = 'error';
    UPDATE agent_calls SET status = 'failed' WHERE status = 'error';
    CREATE TABLE IF NOT EXISTS run_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL REFERENCES runs(id),
      type TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq);
  `,
};
