# ADR-003 — Agent-to-agent communication

**Status:** Accepted
**Date:** 2026-08-14

## Context

Agents must be able to talk to each other without routing everything through the
human. Two agents blocked on each other, or a message chain that never
terminates, are the failure modes that turn "autonomous team" into "hung
process burning tokens".

## Decision

A single in-process **message bus** owns all agent-to-agent traffic, with two
delivery modes exposed as tools:

- **`send_message` (asynchronous).** The message is persisted into the
  recipient's inbox. Nobody blocks. Pending inbox messages are injected into the
  recipient's next activation prompt, and `check_inbox` lets an agent pull them
  on demand.
- **`ask_agent` (synchronous).** The sender is parked while the recipient is
  activated to answer, and the answer returns as the tool's result. The
  question and the answer are both persisted, correlated by `correlationId`,
  with the answer's `replyTo` pointing at the question.

### Guards

Every delivery passes `checkRoute` before anything is persisted:

| Guard | Rule |
| --- | --- |
| Permission | `sender.canMessage` must include the recipient's handle, or `*`. |
| Hop limit | A chain may take at most `maxHops` agent-to-agent hops. |
| Recursion depth | Nested synchronous asks are capped at `maxRecursionDepth`. |
| Cycle detection | A synchronous ask is refused when the recipient already appears in the chain's `path` — that is precisely the shape of an A-asks-B-asks-A deadlock. |
| Message limits | Per run (`maxMessagesPerRun`) and per recipient (`agent.limits.maxMessages`). |
| Timeout | An ask that is not answered within `askTimeoutMs` fails rather than hanging. |

Additionally, a **per-agent mutex** serialises answers: two agents asking the
same teammate queue up instead of interleaving that agent's context.

A rejection is not an exception thrown at the model. `send_message` reports
per-recipient which deliveries succeeded and why the others did not, so the
agent can adapt — and the refusal is recorded on the run timeline.

### Message shape

Messages carry `hop` and `path` (the chain of agent ids they descend from),
which is what makes the guards cheap and auditable after the fact. Status moves
`pending → read → processing → completed` (or `failed`), so an inbox is a real
work queue rather than a log.

The human is a first-class participant: `user` is always a valid recipient of
`send_message`, and the human can inject a message into a live run from either
UI. `ask_agent` deliberately refuses to target the human — blocking an agent on
a person who may be asleep is a hang, not a conversation.

## Consequences

- Deadlock between agents is structurally prevented, not merely discouraged in a
  prompt.
- Every conversation is persisted and therefore replayable and searchable.
- The cost is that a synchronous ask consumes an activation of the recipient,
  which counts against the run's activation budget. That is honest: it really is
  work being done.

## Alternatives considered

- **Broadcast-only / shared scratchpad.** Simpler, but it makes "who is blocked
  on whom" invisible and makes review workflows awkward.
- **Letting the orchestrator relay every message.** Rejected: it serialises all
  communication through one agent and doubles the token cost of every exchange.
