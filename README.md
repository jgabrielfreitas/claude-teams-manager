# Claude Team Manager

Build, configure and run **teams of specialised Claude agents** that coordinate
on a single objective — from a terminal UI or from a browser, backed by one
shared application core.

An architect breaks the objective into tasks and delegates. A backend and a
frontend engineer work in parallel. The backend gets stuck and *asks the
architect directly* — no human in the middle. A reviewer gates the result. You
watch all of it happen live, approve the dangerous bits, and it is all still
there tomorrow morning.

```
Team: Engineering                                   run · 00:04:31 · $0.42

Orchestrator
├── Architect          Opus     high    ◍ thinking
├── Backend Engineer   Sonnet   medium  ● working    → Implement token refresh
├── Frontend Engineer  Sonnet   medium  ◐ waiting    → blocked on api
├── QA Engineer        Sonnet   high    ○ idle
└── Code Reviewer      Opus     high    ⧗ in review
```

**Every agent has its own model and its own reasoning effort.** Nothing is
inherited from the orchestrator, and every log line records which configuration
was actually used.

---

## Contents

- [Quick start](#quick-start)
- [Onboarding](#onboarding)
- [The TUI](#the-tui)
- [The Web UI](#the-web-ui)
- [CLI reference](#cli-reference)
- [Teams](#teams)
- [Agents](#agents)
- [Models](#models)
- [Effort](#effort)
- [Agent-to-agent communication](#agent-to-agent-communication)
- [Tasks, runs and the orchestrator](#tasks-runs-and-the-orchestrator)
- [Permissions and human approval](#permissions-and-human-approval)
- [Budgets](#budgets)
- [Workspaces and git](#workspaces-and-git)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Development](#development)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## Quick start

**Requirements:** Node 20.11+ and pnpm 10+. Either an authenticated Claude Code
installation (run `claude` once and log in) or `ANTHROPIC_API_KEY` in the
environment.

```bash
pnpm install
pnpm tui          # terminal UI  (first run: onboarding wizard)
pnpm web          # web UI       → http://localhost:4318
```

`pnpm web` starts two processes: the API server on **4317** and the Vite dev
client on **4318**, which proxies `/api` to it. Open **4318**. For a single-port
production server, `pnpm build` then `pnpm --filter @claude-team/web start`,
which serves the built client from **4317**.

That is the whole setup. There is no service to start, no database to
provision: state lives in a single SQLite file under `~/.claude-team/`.

To try the entire product without spending a token, run either surface with the
deterministic provider. It ships a demo fixture that produces a real task DAG,
real delegation, real agent-to-agent messages and a real review — so you see the
whole product, identically in both surfaces:

```bash
pnpm tui -- --provider fake
pnpm web -- --provider fake
```

Verify your real Claude connection end to end at any time:

```bash
pnpm smoke                      # one agent, reads a file, reports back (~$0.06)
pnpm tsx scripts/smoke-team.ts  # two agents, real delegation (~$0.50)
```

---

## Onboarding

On first run you get a wizard — the same one in both surfaces. Its rule is
**never ask for something that can be discovered**, so it starts by detecting:

- whether the Claude CLI is installed, and its version;
- whether you are already authenticated, and how (subscription vs API key);
- MCP servers already configured on this machine (user and project scope);
- which command-line tools agents will find (`git`, `node`, `pnpm`, `docker`, …);
- your current directory, and whether it is a git repository (branch, dirty
  files, last commit);
- where the database will live, and whether you already have teams.

Then it asks only what is genuinely yours to decide:

```
Welcome to Claude Team Manager

  ✓ Claude CLI found (2.1.233)
  ✓ Authenticated via your Claude subscription
  ✓ 3 MCP servers configured: linear, slack, context7
  ✓ Workspace ~/projects/my-app is a git repo on main (2 uncommitted files)

1. Choose a team preset      → Software Engineering
2. Confirm each agent        → model and effort, per agent
3. Review permissions        → what needs your approval
4. What should the team do?  → Implement OAuth login
```

Rerun it later from the command palette (**Run Onboarding Again**) or with
`claude-team onboarding`.

---

## The TUI

```bash
pnpm tui
# or, after linking the workspace binary:
claude-team
agents
```

Seven sections — Dashboard, Teams, Agents, Runs, Messages, Activity, Settings —
in a two-pane layout with live updates pushed from the core (no polling).

### Keyboard

| Key | Action |
| --- | --- |
| `↑` `↓` | navigate |
| `↵` | select |
| `tab` | switch panel |
| `1`–`7` | jump to a section |
| `c` | create |
| `e` | edit |
| `d` | delete |
| `r` | start a run |
| `p` | pause a run |
| `x` | cancel a run |
| `m` | send a message to an agent |
| `l` | open the run timeline |
| `i` | inspect an agent |
| `/` | search across teams, agents, runs, tasks and messages |
| `ctrl+k` | command palette |
| `?` | help |
| `q` | quit |

### Agent inspector

```
Agent: Backend Engineer                                        ● working

Model     Sonnet                 Messages     12
Effort    Medium                 Tool calls   28
Team      Engineering            Runtime      4m 32s

Current task
  Implement token refresh

Inbox
  #123  architect → backend   Implement the authentication service.
  #124  reviewer  → backend   Fix the race condition in token refresh.

Can message: architect, frontend, qa, reviewer
```

---

## The Web UI

```bash
pnpm web        # → http://localhost:4318 (API on 4317)
```

Pages: `/dashboard`, `/teams`, `/teams/:teamId`, `/agents`, `/agents/:agentId`,
`/runs`, `/runs/:runId`, `/settings`, plus `/messages` and `/activity`.

It talks to a small HTTP API over the *same* application core the TUI uses, and
receives live updates over Server-Sent Events.

> **One surface at a time.** Both UIs read and write the same local SQLite
> database, and exactly one process may own the runtime for it. Whichever you
> start first takes an advisory lock; a second one opens read-mostly and says
> so, rather than pausing runs the first is executing. Use the surface you
> prefer, switch freely between them — but do not expect a run started in the
> terminal to be controllable from a browser tab open at the same time. (Give
> them separate `CLAUDE_TEAM_HOME` directories if you want both live at once.)

```
Engineering Team                                    ▶ running  ████████░░  78%

Task
Build authentication system

Agents
  Architect          Claude Opus     Effort: High     ◍ Thinking
  Backend            Claude Sonnet   Effort: Medium   ● Working
  Frontend           Claude Sonnet   Effort: Medium   ◐ Waiting
  Reviewer           Claude Opus     Effort: Max      ○ Idle
```

---

## CLI reference

```bash
claude-team                              # TUI (onboarding on first run)
claude-team --help
claude-team --version

claude-team team list
claude-team team export engineering      # YAML to stdout
claude-team team import engineering.yaml

claude-team agent list

claude-team run "Implement OAuth login" --team engineering

# Options
--provider fake      # deterministic provider; no tokens spent
--db <path>          # use a specific database file
```

`CLAUDE_TEAM_HOME` relocates the whole data directory, which is handy for
keeping a project-local set of teams:

```bash
CLAUDE_TEAM_HOME=./.claude-team claude-team
```

---

## Teams

A team is a named group of agents sharing a workspace, with one of them
designated **orchestrator**.

Create one from scratch or from a preset:

| Preset | Members |
| --- | --- |
| **Software Engineering** | Architect (orchestrator), Backend, Frontend, QA, Reviewer |
| **Research** | Research Lead (orchestrator), Web Researcher, Data Analyst, Fact Checker, Writer |
| **Product** | Product Manager (orchestrator), Researcher, UX, Engineer, Reviewer |
| **Review Board** | Tech Lead (orchestrator), Reviewer, Security, QA — read-only, makes no changes |
| **Solo Agent** | One generalist |

A preset is only a starting point: it is expanded into real agents whose model,
effort, prompt, permissions and routing you can change individually.

Teams can be duplicated, exported, imported and deleted. The export is a YAML
file designed to be **committed to git and reviewed in a pull request**:

```yaml
name: engineering
orchestrator: architect

agents:
  architect:
    role: Software Architect
    model: opus
    effort: high

  backend:
    role: Backend Engineer
    model: sonnet
    effort: medium

  reviewer:
    role: Code Reviewer
    model: opus
    effort: high
```

The full schema is documented in [`docs/team-format.md`](docs/team-format.md).

---

## Agents

Every agent is configured independently:

| Field | What it does |
| --- | --- |
| `name`, `role`, `description` | Identity, shown in every view |
| `systemPrompt` | The persona and instructions. Yours; never rewritten |
| `model` | **Per agent.** Any provider model id |
| `effort` | **Per agent.** `low` / `medium` / `high` / `max` |
| `tools` | Capability groups, each `allow` / `ask` / `deny` |
| `workspace` | Overrides the team workspace |
| `context` | Static context injected into every activation |
| `memory` | Durable notes the agent writes itself with `remember` |
| `communicationRules` | How this agent should talk to teammates |
| `canMessage` | Which teammates it may address (`['*']` for everyone) |
| `limits` | `maxTurns`, `timeout`, `maxMessages` |
| `status` | Live: idle / thinking / working / waiting / blocked / failed |

### Templates

Create from scratch or from a template: Software Architect, Tech Lead, Backend
Engineer, Frontend Engineer, Mobile Engineer, QA Engineer, Code Reviewer, DevOps
Engineer, Product Manager, Researcher, Research Lead, Data Analyst, Fact
Checker, Writer, UX Designer, Security Reviewer, Database Specialist,
Generalist.

### Cloning

Duplicate an agent to specialise it, keeping its prompt and configuration:

```
backend  →  backend-payments
         →  backend-auth
```

A clone starts with an empty memory — memory is about work already done.

---

## Models

`agent.model` is an opaque string passed straight through to the provider, so a
model works the day it ships without waiting for a release of this tool. The
picker is populated by **live discovery** from your Claude installation, falling
back to a built-in catalogue.

Defaults use the moving aliases `opus`, `sonnet` and `haiku`, so a team exported
today still works after the next model release. Pin an exact id
(`claude-opus-4-8`) when you need reproducibility.

Change one agent's model without touching anyone else:

- TUI: select the agent, press `M`
- Web: agent page → Model
- Palette: **Switch Model**

---

## Effort

Reasoning effort is a first-class, per-agent setting:

| Level | Use it for |
| --- | --- |
| `low` | Mechanical, well-specified work |
| `medium` | Most implementation work |
| `high` | Architecture, review, tricky debugging |
| `max` | Maximum deliberation; slowest and most expensive |

A typical team mixes them deliberately:

```
Architect   Opus     max
Backend     Sonnet   high
Frontend    Sonnet   medium
Reviewer    Opus     high
```

The domain owns these four levels; an adapter maps them to whatever the provider
calls it (see [ADR-004](docs/adr/004-provider-abstraction.md)). Every
`agent_started` and `agent_stopped` event records the model **and** effort
actually used, so cost attribution and replay are exact.

---

## Agent-to-agent communication

Agents talk to each other directly. Not everything has to route through you.

**Asynchronous** — fire and forget, lands in the recipient's inbox:

```
Architect → Backend
Please implement the authentication service according to ADR-002.
```

**Synchronous** — the asker is parked until the answer comes back:

```
Backend → Architect     (blocking)
The API requires refresh-token rotation.
Should this be persisted in Redis or Postgres?

Architect → Backend
Use Redis for session state. Document the decision.
```

Each agent has a real inbox, with message statuses `pending → read → processing
→ completed` (or `failed`).

### Deadlock and runaway protection

Guards are enforced by the runtime, not requested in a prompt:

- **Permission** — `canMessage` decides who may address whom.
- **Hop limit** — a message chain may take at most `maxHops` hops.
- **Recursion depth** — nested synchronous asks are capped.
- **Cycle detection** — an ask that would return to an agent already waiting
  upstream is refused. That is exactly the A-asks-B-asks-A deadlock.
- **Per-agent mutex** — two agents asking the same teammate queue instead of
  interleaving its context.
- **Message limits** — per run and per recipient.
- **Timeouts** — an unanswered ask fails instead of hanging.

A refused delivery is reported back to the sending agent with the reason, and
recorded on the run timeline.

---

## Tasks, runs and the orchestrator

Starting a run gives the orchestrator the objective and a set of **real tools**:
`create_tasks`, `list_tasks`, `update_task`, `finish`. Calling `create_tasks`
genuinely inserts tasks that the scheduler then dispatches — there is no prose
parsing anywhere.

Tasks form a dependency DAG:

```
Architecture
    ├──── Backend ────┐
    └──── Frontend ───┴──→ Integration ──→ Review
```

The scheduler works out what is runnable and dispatches **every ready task
concurrently**, each with its own agent's model, effort, capabilities and
working directory. A task with a reviewer goes to `review` and needs an explicit
`VERDICT: APPROVED` before it counts as done.

Task states: `pending → ready → running → review → completed`, plus `blocked`,
`failed` and `cancelled`.

Runs support `start`, `pause`, `resume`, `cancel` and `retry`. Pausing takes
effect at the next safe point, so in-flight agent activations finish rather than
being torn in half.

### Observability

Every run has a complete, sequence-numbered timeline:

```
14:31:02  architect started (opus, effort high)
14:31:09  architect created "Implement the authentication service"
14:31:10  "Implement the authentication service" assigned to backend
14:31:12  "Build the login screen" assigned to frontend
14:31:40  backend asked architect: Redis or Postgres for refresh tokens?
14:31:46  architect answered backend: Use Redis for session state.
14:32:15  backend completed "Implement the authentication service"   1m 05s  $0.08
14:32:16  reviewer started (opus, effort high)
```

Recorded: messages, task creation and assignment, agent start and stop, the
model and effort used, tool calls and results, errors, durations, token usage
and cost. Open a finished run and **replay** it step by step.

### When things fail

Errors are states, not crashes: `agent_failed`, `task_failed`, `provider_error`,
`tool_error`, `timeout`, `budget_exceeded`, `permission_denied`. A failed task
is retried up to `maxAttempts`, then becomes a fact the orchestrator has to deal
with — reassign, replace, or finish and report the blocker honestly. A run only
reports `failed` when it produced nothing usable.

---

## Permissions and human approval

Agents are granted **capability groups**, not raw tool names:

`filesystem_read` · `filesystem_write` · `terminal` · `git` · `network` ·
`browser` · `mcp` · `agent_messaging`

Each is `allow` (no prompt), `ask` (a human approves each use) or `deny` (the
tool is not available to the agent at all).

When an agent reaches for an `ask` capability, it is parked and you get:

```
Backend wants to run:

  rm -rf ./generated

  category: destructive operations

[y] once   [a] always for this run   [n] deny
```

"Always" is scoped to the run and the category, exactly as promised — it never
leaks into the next run. Unanswered requests are denied after a timeout rather
than hanging forever.

Approval categories: filesystem write, shell commands, git, network, MCP,
external APIs, destructive operations. Settings can force a category to always
require approval even when the capability says `allow`.

Note that `git` and `terminal` interact deliberately: git runs through the
shell, so `git: allow` with `terminal: deny` permits `git …` and refuses every
other command.

---

## Budgets

Optional, per run (a team default can be set, and overridden at start):

```yaml
budget:
  maxTokens: 1000000
  maxCostUsd: 20
  maxDurationMinutes: 60
  maxAgentActivations: 60
```

And per agent:

```yaml
limits:
  maxTurns: 30
  maxMessages: 100
```

Budgets are checked before an activation is dispatched and after it returns, so
an over-spend stops the run immediately. You get warnings at 50%, 80% and 95%.

---

## Workspaces and git

A team points at a workspace; its agents share it by default and can override it
individually. When the workspace is a git repository, the branch, uncommitted
file count, last commit and upstream divergence are shown in both UIs and given
to the agents as context.

The architecture is prepared for per-agent **git worktree** isolation — the
runtime already models "a checkout" rather than "the checkout" — so parallel
agents can be given separate worktrees without changes above the runtime layer.

---

## Configuration

Everything lives under `~/.claude-team/` (or `$CLAUDE_TEAM_HOME`):

```
~/.claude-team/
    claude-team.db      teams, agents, runs, tasks, messages, events, settings
```

Settings (edit in the Settings section of either UI):

| Setting | Meaning |
| --- | --- |
| `defaultModel`, `defaultOrchestratorModel`, `defaultEffort` | Defaults for new agents |
| `defaultWorkspace` | Suggested workspace for new teams |
| `provider` | `claude` or `fake` |
| `defaultBudget` | Applied to teams that define none |
| `requireApprovalFor` | Categories that always need a human |
| `autoApproveAll` | Skip every prompt (dangerous, opt-in) |
| `maxHops`, `maxRecursionDepth`, `askTimeoutMs` | Communication guards |
| `webPort` | Port for the API server (default 4317; `PORT` overrides it) |
| `theme` | `auto` / `dark` / `light` |

Agents run with `settingSources: []`, meaning your personal Claude Code settings
files are deliberately **not** loaded — a team behaves identically on every
machine.

---

## Architecture

```
                  ┌──────────────┐
                  │     TUI      │
                  └──────┬───────┘
                         │
                         ▼
┌──────────────┐   ┌──────────────┐
│    Web UI    │──▶│  Application │
└──────────────┘   │     Core     │
                   └──────┬───────┘
                          │
          ┌───────────────┼─────────────────┐
          ▼               ▼                 ▼
      Agent Runtime   Persistence      Claude Adapter
          │
          ▼
   Agent Collaboration
```

```
packages/
  domain/           entities, invariants, state machines, DAG logic, routing
                    rules, validation schemas, templates, presets, YAML format
  persistence/      Storage interface + SQLite and in-memory implementations
  provider/         AgentProvider interface, ClaudeProvider, FakeAgentProvider
  runtime/          message bus, scheduler, orchestration loop, budgets,
                    approvals, run engine, run manager
  core/             AppCore — every use case — plus the event bus and search
  protocol/         HTTP route table, DTOs, typed API client
  ui-shared/        status vocabulary, formatters, command catalogue

apps/
  tui/              Ink terminal UI
  web/              Hono server + React client
```

**There is exactly one implementation of every rule.** The TUI holds an
`AppCore` in-process; the web server holds an `AppCore` in-process and its HTTP
handlers delegate to it one-to-one. Neither contains a business rule of its own.
The domain is isomorphic, so the browser bundle imports the same entities, the
same validation and the same `availableRunActions` the server uses.

Decisions are recorded in [`docs/adr/`](docs/adr/):

- [001 — One application core, two presentations](docs/adr/001-core-shared-between-tui-and-web.md)
- [002 — Tool-driven orchestration over a task DAG](docs/adr/002-agent-runtime.md)
- [003 — Agent-to-agent communication](docs/adr/003-agent-communication.md)
- [004 — Provider abstraction and the Claude integration](docs/adr/004-provider-abstraction.md)
- [005 — Persistence](docs/adr/005-persistence.md)

### Why the Claude Agent SDK

The integration uses the official TypeScript **Claude Agent SDK** rather than
parsing CLI output: it provides a typed message stream, a real permission
callback, in-process MCP tools, per-query model *and* effort selection,
interruption, and token/cost accounting. Nothing above `packages/provider`
knows the SDK exists — adding `OpenAIProvider` later means one new file and one
`registerProvider` call.

---

## Development

```bash
pnpm install
pnpm dev          # TUI
pnpm tui
pnpm web
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

The repository is a pnpm workspace with TypeScript project references. Packages
resolve to source in development, so there is no build step between editing a
package and running an app.

Useful during development:

```bash
pnpm tui -- --provider fake --db /tmp/scratch.db
pnpm web -- --provider fake
```

---

## Testing

```bash
pnpm test
```

149 tests, none of which touch the Claude API:

- **Domain** — agent and team creation, handle uniqueness, cloning semantics,
  effort coercion, capability resolution, destructive-command detection, message
  routing and every guard, task dependency resolution, cycle detection,
  topological order, run and task state machines, YAML round-trip.
- **Provider** — capability→tool expansion including the git/shell interaction,
  approval categorisation, the effort adapter.
- **Persistence** — a shared conformance suite run against *both* the SQLite and
  in-memory implementations: CRUD, cascades, unique constraints, sequence
  monotonicity under concurrency, filters, lossless round-trip.
- **Runtime & use cases** — full orchestration through the DAG, synchronous and
  asynchronous agent messaging, mutual-ask deadlock refusal, per-agent inbox
  limits, review verdicts, retries, budget enforcement, cancellation, per-agent
  model/effort isolation, refusing a premature `finish`, approvals (allow once,
  allow always, deny, timeout, auto-approve), persistence across a simulated
  restart, and recovery of interrupted runs.

- **Instance lock** — the guard that stops a second surface from pausing a run
  the first one is executing, including takeover of a lock left by a crash.

`FakeAgentProvider` is a real implementation of `AgentProvider`, not a stub: it
honours capability grants, invokes the host's in-process tools, drives the
approval callback, reports usage and cost, and can be cancelled — which is what
makes the whole runtime testable deterministically.

For the parts a fake cannot prove, two scripts hit the real API:

```bash
pnpm smoke                      # provider health, live model discovery, one agent
pnpm tsx scripts/smoke-team.ts  # real orchestrator delegating to a real worker
```

---

## Troubleshooting

**"Not authenticated" / the provider health check fails.**
Run `claude` once and log in, or export `ANTHROPIC_API_KEY`. Verify with
`pnpm smoke`, which prints exactly what was detected.

**The Claude CLI is not found.**
The SDK spawns the `claude` binary. Install Claude Code and make sure it is on
`PATH`; the onboarding wizard reports what it found.

**A run does nothing and finishes immediately.**
Check the run timeline. The most common cause is a team whose orchestrator has
no teammates it is allowed to message, or agents with every capability denied.
Both are visible in the team view.

**An agent is stuck on "waiting".**
It is almost always waiting for a human approval. Look for the approval prompt
in the TUI, the modal in the web UI, or the Pending Approvals card on the
dashboard.

**The run stopped with "budget exhausted".**
Raise the budget on the team, or per run when starting it. Totals for the run
are on the run page.

**A run was interrupted by a restart.**
It is marked `paused`, with its history intact. Resume it or cancel it
deliberately; nothing is silently resurrected.

**`pnpm install` complains about `better-sqlite3`.**
It ships prebuilt binaries for common platforms and the workspace already
allow-lists its build script. On an unusual platform you need a C++ toolchain
for the fallback compile.

**Two copies of the app at once.**
SQLite here is single-writer, so one process owns the runtime. The first to
start takes an advisory lock (`~/.claude-team/instance.lock`); a second one
starts read-mostly and emits a warning naming the pid that holds it, instead of
interfering with the running instance. A lock left by a crashed process is
taken over automatically (dead pid, or no heartbeat for 45s). To run two live
instances, give them separate `CLAUDE_TEAM_HOME` directories.

**I want to start over.**
Delete `~/.claude-team/` (or your `CLAUDE_TEAM_HOME`). Export any teams you want
to keep first — that is what the YAML format is for.
