# ADR-004 — Provider abstraction and the Claude integration

**Status:** Accepted
**Date:** 2026-08-14

## Context

The product is about Claude teams today, but the domain should not be welded to
one vendor's parameter names — nor to one *version* of that vendor's API. At the
same time, the first release has to be a genuinely complete Claude integration,
not a placeholder.

We also had to choose *how* to drive Claude. The candidates were the raw
Messages API, shelling out to the `claude` CLI and parsing its output, and the
official TypeScript **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`).

## Decision

### The seam

`packages/provider/src/types.ts` defines `AgentProvider`:

```ts
interface AgentProvider {
  run(input: AgentRunInput): AsyncIterable<AgentEvent>
  cancel(activationId: string): Promise<void>
  getModels(): Promise<ModelDefinition[]>
  healthCheck(): Promise<ProviderHealth>
}
```

Nothing above this line knows what the SDK's options are called. Two concrete
implementations ship: `ClaudeProvider` and `FakeAgentProvider`. A registry maps
provider ids to factories, so `OpenAIProvider` would be a new file plus one
`registerProvider` call.

### Why the Agent SDK

We use the official SDK rather than parsing terminal output. It gives us a typed
message stream, a real permission callback, in-process MCP tools, per-query model
**and effort** selection, interruption, and token/cost accounting — all things we
would otherwise have to reconstruct unreliably from text.

### Model is an opaque string

`agent.model` is stored verbatim and passed through. The built-in catalogue only
powers pickers and display names; it is never a whitelist, so a user can type a
model id the day it ships. `ClaudeProvider.getModels()` prefers live discovery
from the SDK and falls back to the built-in list.

The defaults are the moving aliases (`opus`, `sonnet`, `haiku`) rather than
pinned ids, so a team exported today still works after the next model release.
Pinned ids remain available for reproducibility.

### Effort is a domain concept with an adapter

The domain has four levels: `low | medium | high | max`. The SDK currently
exposes five (`low | medium | high | xhigh | max`). `effort-adapter.ts` maps
between them explicitly, and keeps a thinking-token-budget fallback for provider
builds that do not accept an `effort` option. A change on either side is a
one-line edit in that file rather than a data migration.

**Model and effort are per agent and are never inherited.** Every activation
passes `agent.model` and `agent.effort`, and every `agent_started` /
`agent_stopped` event records which values were actually used.

### Capabilities, not tool names

Agents are configured with capability groups (`filesystem_read`,
`filesystem_write`, `terminal`, `git`, `network`, `browser`, `mcp`,
`agent_messaging`), each `allow | ask | deny`. `tool-mapping.ts` is the only
place that knows Claude's tools are called `Read`, `Bash`, `WebFetch` and so on.

This keeps exported team YAML portable, and it lets us express things the raw
tool list cannot. The interesting case is git: git runs through the shell, so
`git: allow` with `terminal: deny` resolves `Bash` to *ask*, and the permission
callback then allows `git …` while denying everything else.

### Permissions reach the human

`ask` capabilities are routed through the SDK's `canUseTool` callback into the
runtime's approval gate, which persists the request, notifies both UIs, and
parks the agent until a human answers (or the request times out and is denied).
"Allow always" is scoped to the run and the category, exactly as the prompt
promises.

### Isolation from local configuration

The provider runs with `settingSources: []`, so a team behaves identically on
every machine regardless of the operator's personal Claude Code settings.

### Structural typing at the boundary

The adapter consumes a documented subset of the SDK's message union through
narrow structural types rather than importing the union itself. Additive SDK
changes therefore cannot break the build, and the fields we do read are
explicit and reviewable in one file.

## Consequences

- Adding a provider does not touch a use case, a UI or the storage schema.
- The entire runtime is testable without network access or spend, because
  `FakeAgentProvider` is a real implementation of the same interface — it honours
  capability grants, invokes the host's in-process tools, reports usage and
  cost, and can be cancelled.
- The cost is one extra translation layer per concept (effort, tools, events).
  That layer is small, and it is where every vendor-specific surprise gets
  absorbed.
