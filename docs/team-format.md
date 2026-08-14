# Team file format (v1)

A team is exportable to a single YAML file that is meant to be **committed to
git and reviewed in a pull request**. It is keyed by agent *handles* rather than
database ids, and describes capabilities as portable groups rather than one
provider's tool names, so a file exported on one machine imports cleanly into a
fresh install.

```bash
claude-team team export engineering > engineering.yaml
claude-team team import engineering.yaml
```

## Minimal example

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

Everything except `name`, `agents` and each agent's `role` is optional and falls
back to a sensible default.

## Full example

```yaml
version: 1
name: engineering
description: Ships the product
workspace: ~/projects/my-app
orchestrator: architect
default_agent: architect

budget:
  maxTokens: 2000000
  maxCostUsd: 20
  maxDurationMinutes: 60
  maxAgentActivations: 60

agents:
  architect:
    name: Architect
    role: Software Architect
    description: Owns system design and delegates to the team.
    model: opus
    effort: high
    system_prompt: |
      You are the Software Architect of this team.
      Read the existing code before proposing anything.
    context: |
      This service is deployed to Cloud Run and talks to Postgres.
    communication_rules: |
      Answer teammates quickly; they are blocked while waiting on you.
    tools:
      filesystem_read: allow
      filesystem_write: ask
      terminal: ask
      git: ask
      network: ask
      browser: deny
      mcp: ask
      agent_messaging: allow
    can_message: ['*']
    limits:
      maxTurns: 30
      timeoutMs: 900000
      maxMessages: 100

  backend:
    role: Backend Engineer
    model: sonnet
    effort: medium
    workspace: ~/projects/my-app/services/api
    tools: [filesystem_read, filesystem_write, terminal, git, agent_messaging]
    can_message: [architect, frontend, reviewer]
```

## Field reference

### Top level

| Field | Type | Notes |
| --- | --- | --- |
| `version` | number | Format version. Omit to mean 1. A newer version imports with a warning rather than failing. |
| `name` | string | **Required.** |
| `description` | string | |
| `workspace` | string | `~` is expanded on import. |
| `orchestrator` | handle | Which agent runs the show. Falls back to the first agent. |
| `default_agent` | handle | Used when the human addresses "the team". |
| `budget` | object | `maxTokens`, `maxCostUsd`, `maxDurationMinutes`, `maxAgentActivations`. |
| `agents` | map | **Required**, at least one entry. The key is the agent's handle. |

### Per agent

| Field | Type | Notes |
| --- | --- | --- |
| `role` | string | **Required.** |
| `name` | string | Defaults to the handle. |
| `description` | string | |
| `model` | string | Any provider model id. Not validated against a whitelist, so a new model works the day it ships. Defaults to the app's default model. |
| `effort` | `low` \| `medium` \| `high` \| `max` | Per agent. Loose values (`HIGH`, `maximum`, `xhigh`) are coerced. |
| `system_prompt` | string | The agent's persona and instructions. `systemPrompt` also accepted. |
| `context` | string | Static context injected into every activation. |
| `memory` | string | Seed notes. Working memory is *not* exported — it is per-installation state. |
| `communication_rules` | string | `communicationRules` also accepted. |
| `tools` | map or list | See below. |
| `can_message` | list of handles | `['*']` means everyone. Unknown handles are dropped with a warning. `canMessage` also accepted. |
| `workspace` | string | Overrides the team workspace for this agent. |
| `limits` | object | `maxTurns`, `timeoutMs`, `maxMessages`. |
| `template` | string | The template this agent came from, for reference. |

### Capabilities (`tools`)

Two forms are accepted.

**Map form** — explicit mode per group:

```yaml
tools:
  filesystem_read: allow
  filesystem_write: ask
  terminal: deny
```

**List form** — the listed groups are `allow`, everything else is `deny`:

```yaml
tools: [filesystem_read, filesystem_write, git, agent_messaging]
```

Groups: `filesystem_read`, `filesystem_write`, `terminal`, `git`, `network`,
`browser`, `mcp`, `agent_messaging`.
Modes: `allow` (no prompt), `ask` (a human approves each use), `deny` (the tool
is not available to the agent at all).

Note that `git` and `terminal` interact: git runs through the shell, so
`git: allow` with `terminal: deny` results in git commands being permitted while
every other shell command is refused.

## Import behaviour

- Handles are made unique on import; a collision gets `-2`, `-3`, …
- An `orchestrator`, `default_agent` or `can_message` entry that names an agent
  not present in the file is **dropped with a warning** rather than failing the
  whole import — a partially-valid file still gets you a working team.
- A file that is not valid YAML, or that has no agents, is rejected with a
  message naming the offending field.
- Ids, run history and agent memory are never part of the file. Importing always
  produces a brand new team.
