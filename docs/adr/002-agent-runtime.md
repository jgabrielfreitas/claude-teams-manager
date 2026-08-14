# ADR-002 — Tool-driven orchestration over a task DAG

**Status:** Accepted
**Date:** 2026-08-14

## Context

A team needs to turn one human objective into coordinated work by several
agents. The two obvious designs are:

1. **Hard-coded orchestration** — the engine decides the phases and the agents
   fill in the blanks.
2. **Prompt-convention orchestration** — the orchestrator writes a plan in prose
   and the engine parses it.

The first cannot adapt to the objective. The second is exactly the fragile
output-parsing we set out to avoid.

## Decision

The orchestrator is a normal agent that has been given **real host tools**:
`create_tasks`, `list_tasks`, `update_task`, `finish`, plus the messaging tools
every agent gets. These are in-process functions exposed to the model through
the provider's MCP support (see ADR-004) — calling `create_tasks` genuinely
inserts task rows.

The engine loop is:

1. Activate the orchestrator with the objective (round 1) or the task board plus
   new messages (later rounds).
2. Recompute derived task statuses from the dependency graph
   (`recomputeTaskStatuses`): a task becomes `ready` when every dependency is
   `completed`, and `blocked` when a dependency failed.
3. Dispatch **every ready task concurrently**, each with its own agent's model,
   effort, capabilities and working directory.
4. When a task has a reviewer, run the reviewer and require an explicit
   `VERDICT:` line; a rejection sends the task back for another attempt.
5. Repeat until the orchestrator calls `finish`, the graph settles, the budget
   is exhausted, or the human intervenes.

Guardrails, all enforced by the engine rather than requested in a prompt:

- `maxRounds` — a runaway-loop backstop.
- Stall detection — two rounds with no change in the task fingerprint closes the
  run with what was actually completed.
- Per-task `maxAttempts` — retry, then permanent failure that the orchestrator is
  told about and must react to.
- `maxConcurrentAgents` plus a per-agent mutex, so an agent is never in two
  activations at once and its provider session stays coherent.
- Budget checks before dispatch and after every activation (ADR-005 covers where
  the numbers are stored).

**Task status and run status are explicit state machines** in
`packages/domain/src/transitions.ts`, so both UIs grey out impossible actions
using the same rules the engine enforces.

## Failure handling

Errors are typed (`DomainError.code`) and are *states*, not crashes:
`agent_failed`, `task_failed`, `provider_error`, `timeout`, `budget_exceeded`,
`permission_denied`, `cycle_detected`, `cancelled`. A failed task never takes
down the run; it becomes a fact the orchestrator has to deal with — retry,
reassign, or finish honestly reporting the blocker. A run only reports `failed`
when it produced nothing usable.

## Observability

Every meaningful action is appended to a per-run, sequence-numbered timeline
before it is broadcast, which means a UI that reconnects can always catch up
from `afterSeq` without missing anything. Each `agent_started` / `agent_stopped`
event records **the model and effort actually used**, plus usage, cost and
duration — that is what makes replay and cost attribution real rather than
approximate.

## Consequences

- The orchestrator can adapt: split differently, reassign, add a review step,
  or decide the objective is small enough to do alone.
- Parallelism is a property of the graph, not of a hand-written phase list.
- The engine is testable without a model: `FakeAgentProvider` scripts tool calls
  and the whole loop runs deterministically.
- The orchestrator can, in principle, plan badly. The guardrails bound the damage
  in time, money and turns rather than trying to prevent bad plans.

## Future work

`RunContext` already describes *a* workspace rather than *the* workspace, and
`WorkspaceInfo` reports whether a checkout is a linked worktree. Per-agent git
worktree isolation is therefore an additive change: allocate a worktree per
agent at run start and set `agent.workspace`. Nothing above this layer changes.
