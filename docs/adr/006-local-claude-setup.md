# ADR-006 — Reusing the local Claude Code installation

**Status:** Accepted
**Date:** 2026-08-18

## Context

Agents have always run through the user's own Claude Code installation: the SDK
spawns a `claude` binary and authenticates with the same credentials the CLI
uses, so runs are billed to the user's subscription or `ANTHROPIC_API_KEY`. That
part was never in question.

What was in question is the **configuration**. ADR-004 fixed
`settingSources: []` in `ClaudeProvider`, which meant agents saw none of the
user's memory (`CLAUDE.md`), none of their skills, and none of their MCP
servers. The reasoning was portability: a team file that behaves the same on
every machine.

That reasoning is right for a shared team and wrong for the machine the user
actually works on. Someone whose `~/.claude/skills` already encodes how their
company writes a bug report does not want to paste it into six agent prompts,
and a repo's `CLAUDE.md` is the most accurate description of that repo that
exists. Re-creating all of it inside team files is duplication with a drift
problem.

A second, quieter problem: `settingSources` was a constructor argument, so it
was a property of the *process*. Anything user-facing had to be a restart.

## Decision

Reuse is **a stored setting, off by default, applied per activation**.

```ts
interface LocalSetup {
  settingSources: Array<'user' | 'project' | 'local'>
  skills: 'none' | 'all' | string[]
  mcpServers: boolean
  executablePath?: string
}
```

It lives in `AppSettings.localSetup`, travels on `AgentRunInput.localSetup`, and
`resolveLocalSetup()` — a pure, tested function — is the single place that turns
it into SDK options. Because it rides on the activation rather than on the
provider, changing it in Settings takes effect on the next **run**. The one
exception is `executablePath`, which the health check has no activation to carry
and which is therefore also read at bootstrap.

Anything unrecognised normalises to isolation (`normaliseLocalSetup`). Inheriting
the machine is something you turn on, never something that happens because a
stored value was missing or a file was hand-edited.

### Why off by default

Two reasons, in order of weight.

1. **A user's settings file can pre-approve tools.** A `permissions.allow` entry
   in `~/.claude/settings.json` is honoured by the CLI before our `canUseTool`
   callback is consulted, so those calls would run without this product asking.
   The capability model is the product's main safety claim; weakening it must be
   a deliberate act with the consequence stated on screen, which is what the
   warning in both Settings screens does. Denies still win, because we keep
   passing `disallowedTools`.
2. **Upgrades must not change behaviour.** Migration `004` defaults the column to
   `'{}'`, which normalises to full isolation, so an existing installation runs
   exactly as it did before.

### Why one setting and not per-agent

Per-agent model and effort are core to the product (ADR-002) because they are
properties of the *role*. What a machine has installed is a property of the
*machine*: the same team on a colleague's laptop finds different skills. Putting
it in team files would make them non-portable in a way the format cannot express
honestly. `AgentRunInput` still carries it per activation, so per-agent skill
lists remain possible without a migration.

## Consequences

- Agents can use the user's memory, skills and MCP servers, verified against the
  real API by `pnpm smoke:local`: the same agent, same objective, run isolated
  and then inheriting — only the second knows the workspace codename or can name
  the local skill.
- A team that depends on local skills is no longer portable. This is stated in
  the README rather than prevented; it is the user's trade to make.
- MCP servers authenticated interactively may not connect from a background run.
  Reported as a caveat in the UI, not hidden.
- `ClaudeProvider` now reads two small JSON files to collect MCP configuration,
  cached per workspace.
