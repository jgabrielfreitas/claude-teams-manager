# ADR-005 — Persistence

**Status:** Accepted
**Date:** 2026-08-14

## Context

Everything has to survive a restart: teams, agents, their per-agent model and
effort, runs, tasks, the agent-to-agent conversation, the timeline and the
settings. The tool is local-first and single-user, so a server-class database
would be a deployment burden with no benefit — but the data is genuinely
relational and the timeline needs stable ordering.

## Decision

**SQLite**, at `~/.claude-team/claude-team.db` (overridable with
`CLAUDE_TEAM_HOME`), through `better-sqlite3` — which ships prebuilt binaries,
so `pnpm install` needs no compiler.

The application core depends on a `Storage` interface, never on SQLite. Two
implementations ship:

- `SqliteStorage` — the real one.
- `InMemoryStorage` — complete and semantically identical, deep-cloning on read
  and write, used by the test suite so tests never touch disk.

Both are held to a **shared conformance suite**: the same tests run against both
drivers, which is what keeps the in-memory implementation honest enough to test
against.

### Schema notes

- Dates are stored as epoch millis; structured fields (tool permissions,
  `canMessage`, limits, budgets, dependencies, event payloads, usage) as JSON
  text. The mapping is exhaustive and lossless — optional fields come back as
  `undefined`, not `null`, and dates come back as `Date` objects.
- Foreign keys are enabled and cascades are real: deleting a team removes its
  agents and runs, and deleting a run removes its tasks, messages, events and
  approvals.
- `UNIQUE(team_id, handle)` on agents — a handle is how agents address each
  other, so it has to be unique inside a team.
- Per-run sequence numbers for messages and events are allocated atomically
  (`INSERT … ON CONFLICT DO UPDATE … RETURNING`). Ordering the timeline by
  timestamp would be ambiguous under concurrency; a monotonic `seq` is what makes
  "give me everything after event 412" reliable, which is the basis of both the
  SSE catch-up and the TUI's live view.
- Migrations are versioned and recorded in a `_migrations` table, applied inside
  a transaction. The first release ships one migration; the runner is real so
  the second one is routine.
- WAL journaling, `foreign_keys = ON`, `busy_timeout = 5000`.

### Restart behaviour

On startup the core marks runs that a previous process left mid-flight as
`paused` rather than silently discarding or resurrecting them, and resets agent
statuses to `idle`. History is preserved and the human decides whether to resume
or cancel. Resuming rebuilds the engine from persisted tasks and messages, and
restores each agent's provider session id by scanning the timeline — which is
why session ids are recorded on `agent_started` events rather than kept only in
memory.

### Portable format

The database is an implementation detail; the *sharable* artefact is the team
YAML produced by `toPortableTeam` / `parsePortableTeam`. It is keyed by handles
rather than ids, expresses capabilities as groups rather than provider tool
names, and carries an explicit `version`, so a team file can be committed to git,
reviewed in a pull request, and imported into a fresh install.

## Consequences

- Zero-setup for the user: no service to run, one file to back up or delete.
- The test suite runs the entire runtime in memory, in milliseconds.
- Single-writer: one process owns the runtime for a given database. This is
  enforced by an advisory lock (`instance.lock`, pid + heartbeat) taken during
  `AppCore.init()`. It exists because the failure mode without it is not
  theoretical: a second process's startup recovery would see a `running` row,
  conclude the previous process had died, and pause a run that is very much
  alive. A secondary instance therefore skips recovery entirely, reports itself
  through `core.instanceInfo()`, and emits a `notice` event the UIs can show.
  A lock whose pid is dead — or whose heartbeat is older than 45 seconds — is
  taken over, so a crash never locks the user out.
- Moving to a hosted, multi-user backend later means writing one more `Storage`
  implementation, not rewriting the use cases.
