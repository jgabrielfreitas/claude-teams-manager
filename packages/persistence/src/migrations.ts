import type BetterSqlite3 from 'better-sqlite3';

/**
 * Schema migrations.
 *
 * This is a greenfield project, so there is exactly one migration: the initial
 * schema. The *runner*, however, is real — it records what it applied in
 * `_migrations`, skips anything already applied, and wraps each migration in a
 * transaction — so the second migration can simply be appended to the array.
 */

export type Database = BetterSqlite3.Database;

export interface Migration {
  id: number;
  name: string;
  up: (db: Database) => void;
}

/**
 * Connection-level pragmas.
 *
 * These are per-connection settings, not schema, so they are applied every time
 * a connection is opened rather than inside a migration. `foreign_keys` in
 * particular cannot be toggled inside a transaction, which is why this runs
 * before any migration starts.
 */
export function applyPragmas(db: Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

const INITIAL_SCHEMA = `
CREATE TABLE teams (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  orchestrator_id   TEXT,
  default_agent_id  TEXT,
  workspace         TEXT,
  budget            TEXT,
  preset_id         TEXT,
  metadata          TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE agents (
  id                   TEXT PRIMARY KEY,
  team_id              TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  handle               TEXT NOT NULL,
  name                 TEXT NOT NULL,
  role                 TEXT NOT NULL,
  description          TEXT,
  system_prompt        TEXT NOT NULL DEFAULT '',
  model                TEXT NOT NULL,
  effort               TEXT NOT NULL,
  tools                TEXT NOT NULL DEFAULT '[]',
  workspace            TEXT,
  context              TEXT NOT NULL DEFAULT '',
  memory_enabled       INTEGER NOT NULL DEFAULT 1,
  memory_notes         TEXT NOT NULL DEFAULT '',
  communication_rules  TEXT NOT NULL DEFAULT '',
  can_message          TEXT NOT NULL DEFAULT '[]',
  limits               TEXT NOT NULL DEFAULT '{}',
  status               TEXT NOT NULL DEFAULT 'idle',
  "order"              INTEGER NOT NULL DEFAULT 0,
  template_id          TEXT,
  metadata             TEXT NOT NULL DEFAULT '{}',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE (team_id, handle)
);

CREATE INDEX idx_agents_team_order ON agents(team_id, "order");

CREATE TABLE runs (
  id                     TEXT PRIMARY KEY,
  team_id                TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  objective              TEXT NOT NULL,
  status                 TEXT NOT NULL,
  budget                 TEXT,
  workspace              TEXT,
  agent_config_snapshot  TEXT NOT NULL DEFAULT '[]',
  totals                 TEXT NOT NULL,
  summary                TEXT,
  error                  TEXT,
  retry_of_run_id        TEXT,
  created_at             INTEGER NOT NULL,
  started_at             INTEGER,
  completed_at           INTEGER,
  updated_at             INTEGER NOT NULL
);

CREATE INDEX idx_runs_team_created ON runs(team_id, created_at DESC);
CREATE INDEX idx_runs_status ON runs(status);

CREATE TABLE tasks (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL,
  assigned_agent_id  TEXT,
  dependencies       TEXT NOT NULL DEFAULT '[]',
  created_by         TEXT NOT NULL,
  result             TEXT,
  error              TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  max_attempts       INTEGER NOT NULL DEFAULT 2,
  reviewer_agent_id  TEXT,
  "order"            INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  started_at         INTEGER,
  completed_at       INTEGER
);

CREATE INDEX idx_tasks_run ON tasks(run_id);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  seq             INTEGER NOT NULL,
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  from_participant TEXT NOT NULL,
  to_participants TEXT NOT NULL DEFAULT '[]',
  type            TEXT NOT NULL,
  content         TEXT NOT NULL,
  status          TEXT NOT NULL,
  reply_to        TEXT,
  correlation_id  TEXT,
  task_id         TEXT,
  hop             INTEGER NOT NULL DEFAULT 0,
  path            TEXT NOT NULL DEFAULT '[]',
  error           TEXT,
  created_at      INTEGER NOT NULL,
  read_at         INTEGER,
  completed_at    INTEGER
);

CREATE INDEX idx_messages_run_seq ON messages(run_id, seq);

CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  seq         INTEGER NOT NULL,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  agent_id    TEXT,
  task_id     TEXT,
  message_id  TEXT,
  summary     TEXT NOT NULL DEFAULT '',
  data        TEXT NOT NULL DEFAULT '{}',
  model       TEXT,
  effort      TEXT,
  usage       TEXT,
  cost_usd    REAL,
  duration_ms INTEGER,
  level       TEXT NOT NULL DEFAULT 'info',
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_events_run_seq ON events(run_id, seq);
CREATE INDEX idx_events_created ON events(created_at DESC);

CREATE TABLE approvals (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,
  category     TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  input        TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL,
  decision     TEXT,
  decided_by   TEXT,
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER,
  expires_at   INTEGER
);

CREATE INDEX idx_approvals_run ON approvals(run_id);

CREATE TABLE settings (
  id                          INTEGER PRIMARY KEY CHECK (id = 1),
  onboarding_completed        INTEGER NOT NULL DEFAULT 0,
  default_workspace           TEXT,
  default_model               TEXT NOT NULL,
  default_orchestrator_model  TEXT NOT NULL,
  default_effort              TEXT NOT NULL,
  provider                    TEXT NOT NULL,
  default_budget              TEXT NOT NULL DEFAULT '{}',
  require_approval_for        TEXT NOT NULL DEFAULT '[]',
  auto_approve_all            INTEGER NOT NULL DEFAULT 0,
  max_hops                    INTEGER NOT NULL,
  max_recursion_depth         INTEGER NOT NULL,
  ask_timeout_ms              INTEGER NOT NULL,
  web_port                    INTEGER NOT NULL,
  theme                       TEXT NOT NULL,
  telemetry                   INTEGER NOT NULL DEFAULT 0,
  updated_at                  INTEGER NOT NULL
);

-- Backing store for the atomic per-run sequence allocators used by
-- messages.nextSeq() and events.nextSeq().
CREATE TABLE sequences (
  run_id  TEXT NOT NULL,
  kind    TEXT NOT NULL,
  value   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, kind)
) WITHOUT ROWID;
`;

export const migrations: Migration[] = [
  {
    id: 1,
    name: '001_initial',
    up(db) {
      db.exec(INITIAL_SCHEMA);
    },
  },
];

interface MigrationRow {
  id: number;
}

/**
 * Applies every migration that has not been applied yet, in id order, each one
 * in its own transaction together with its `_migrations` bookkeeping row.
 */
export function applyMigrations(db: Database, list: Migration[] = migrations): void {
  applyPragmas(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT id FROM _migrations').all() as MigrationRow[]).map((r) => Number(r.id)),
  );

  const record = db.prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)');
  const ordered = [...list].sort((a, b) => a.id - b.id);

  for (const migration of ordered) {
    if (applied.has(migration.id)) continue;
    const run = db.transaction(() => {
      migration.up(db);
      record.run(migration.id, migration.name, Date.now());
    });
    run();
  }
}
