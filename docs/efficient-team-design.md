# Efficient team design

This document defines what **efficient team** means in Claude Team Manager.

The goal is not simply to assign cheaper models to more agents. An efficient team
should deliberately optimize the **shape of reasoning, execution and context flow**
through the agent graph.

## Core principles

When designing an efficient squad or team, default to this structure:

1. **One strong orchestrator** owns decomposition, routing and final synthesis.
2. **Cheap scouts** explore the repository, tests, dependencies or failures and return compressed findings.
3. **Expensive specialists** are consultative nodes. They are activated only for hard decisions and should not execute routine implementation work.
4. **Leaf executors** receive narrow, implementation-ready tasks and avoid broad exploration.
5. **Testing is decomposed** into discovery, test writing, execution and failure analysis when that separation reduces context pollution.
6. **Independent review** receives the objective, decisions, diff and test evidence rather than the entire team conversation.
7. **Mechanical work** should go to the cheapest capable model.

A good default engineering topology is:

```text
                         Architect
                         strong model
                              |
             +----------------+----------------+
             |                |                |
         Code Scout       Test Scout    Dependency Scout
         cheap/fast       cheap/fast       cheap/fast
             +----------------+----------------+
                              |
                       compressed briefs
                              |
                         Architect
                              |
                       hard decision?
                        /          \
                      yes          no
                       |            |
                   Specialist       |
                   strong model     |
                       +------------+
                              |
                    narrow implementation
                    +-------------------+
                    |                   |
                 Backend             Frontend
                 executor            executor
                    +---------+---------+
                              |
                         Test Writer
                              |
                         Test Runner
                         cheap/fast
                          /      \
                       fail      pass
                        |          |
                   Debug Scout   Reviewer
                   cheap/fast    strong model
                        |
                     executor
```

## Context efficiency

Model cost is only one dimension of efficiency. **Context quality and context lifetime matter just as much.**

Avoid this pattern:

```text
executor -> broad exploration -> logs -> debugging -> implementation -> tests -> review
```

The same agent accumulates repository search results, dead ends, stack traces and implementation history. Long-running sessions become increasingly noisy and are more susceptible to context rot.

Prefer:

```text
scout -> compressed brief -> executor
```

and, for failures:

```text
test runner -> debug scout -> compressed diagnosis -> executor
```

Agents should transfer **information, not transcripts**.

Scout reports should contain only the useful output of exploration: relevant paths,
symbols, execution flow, evidence, risks and recommended next steps. Raw search output,
large logs and exploratory reasoning should remain inside the scout's context.

## Orchestrator

The orchestrator should normally use one of the strongest models in the team and a
higher reasoning effort. Its value is in making good decomposition and routing decisions
that prevent downstream agents from wasting work.

The orchestrator should:

- understand the objective;
- decide what must be explored before implementation;
- run independent scouts in parallel when useful;
- synthesize scout findings;
- break large goals into small executable tasks;
- decide whether specialist consultation is necessary;
- provide executors with implementation-ready briefs;
- keep unrelated context out of agent handoffs;
- coordinate verification and final review.

The orchestrator should normally **not write application code**. Restricting
`filesystem_write` is a useful way to enforce that separation in the harness.

## Scouts

Scouts are small, cheap exploration nodes. They should usually use a fast model with
low effort and short turn limits.

Common scouts include:

### Code Scout

Finds relevant files, symbols, entry points, existing patterns and execution flow.

### Test Scout

Finds test files, fixtures, commands, analogous tests and likely coverage gaps.

### Dependency Scout

Maps callers, consumers, contracts and blast radius when changing a shared interface,
event, API, schema or module boundary.

### Debug Scout

Receives a failing command plus concise error evidence and produces a root-cause
hypothesis for the executor.

Scouts should generally:

- have `filesystem_write: deny`;
- not make architectural decisions;
- not delegate to other agents;
- report primarily to the orchestrator;
- use narrow `maxTurns` limits;
- compress final responses;
- avoid forwarding raw logs and exploration transcripts.

## Specialists

Specialists are expensive reasoning resources, not default participants in every run.

Examples include backend architecture, frontend architecture and application security.
They should be activated when the cost of a wrong decision is meaningfully higher than
the cost of consultation.

A specialist should receive a **specific question**, not a broad feature objective.
Its answer should normally contain a recommendation, tradeoffs, risks, implementation
constraints and tests that matter.

Specialists should usually have write access disabled so they cannot silently become
executors.

## Leaf executors

Executors perform implementation. They should usually use a capable middle-tier model
with moderate reasoning effort rather than the most expensive model available.

Their context should be intentionally narrow. A good executor handoff contains:

- objective;
- exact scope;
- relevant files and symbols;
- architectural decisions;
- constraints;
- acceptance criteria.

Executors should inspect the referenced code themselves but should avoid broad
repository exploration unless the supplied brief is demonstrably incomplete.

Large features should be decomposed into multiple leaf tasks when the pieces can be
executed independently.

## Test agents

Testing benefits from the same separation of concerns as implementation.

A useful topology is:

```text
Test Scout -> Test Writer -> Test Runner -> Debug Scout
```

The Test Scout discovers patterns and commands. The Test Writer creates focused tests.
The Test Runner executes them and strips irrelevant output. The Debug Scout investigates
failures without filling the executor's context with stack traces and dead ends.

The Test Runner can be one of the cheapest agents in the graph because it should not
reason deeply or modify files.

## Reviewer

The reviewer is a good place to spend model intelligence.

It should act as an independent quality gate and should not implement its own fixes.
Give it only what it needs:

- original objective;
- acceptance criteria;
- important architectural decisions;
- final diff;
- test results.

Avoid giving it all prior team messages. Besides saving tokens, this reduces anchoring
and gives the implementation a genuinely independent second read.

## Mechanical executor

Keep a cheap utility agent for deterministic work such as repetitive renames,
configuration edits, formatting, straightforward documentation changes and mechanical
migrations.

If a utility task becomes ambiguous or begins requiring architectural reasoning, route
it back to the orchestrator rather than allowing the cheap executor to improvise.

## Model and effort allocation

The exact model names depend on the provider, but an efficient engineering team should
generally resemble this allocation:

| Role | Relative model tier | Effort | Typical turn budget |
| --- | --- | --- | ---: |
| Architect | strongest | high | 20-30 |
| Specialist | strongest | high | 6-12 |
| Reviewer | strongest | high | 10-18 |
| Backend / Frontend executor | middle | medium | 20-35 |
| Test Writer | middle | low | 10-18 |
| Code / Test / Dependency Scout | cheapest capable | low | 5-8 |
| Debug Scout | cheapest capable | low | 5-8 |
| Test Runner | cheapest capable | low | 3-6 |
| Utility | cheapest capable | low | 5-12 |

The principle is simple: **spend intelligence where uncertainty and error cost are high;
spend cheap execution where the work is already well specified.**

## Communication graph

Do not connect every agent to every other agent by default.

A constrained communication graph improves context hygiene, prevents redundant
coordination and makes timelines easier to understand.

Useful defaults:

- scouts -> architect;
- architect -> everyone it may activate;
- specialists -> architect and relevant executor/reviewer;
- executors -> architect, relevant specialist and verification agents;
- test runner -> architect/debug scout/test writer;
- utility -> architect;
- reviewer -> architect and responsible executors/specialists.

`can_message` is therefore part of the efficiency architecture, not merely an access-control detail.

## What "efficient" should mean in this project

When a user asks Claude Team Manager to create an **efficient squad**, **efficient team**
or equivalent structure, use these principles as the default design language:

- strong orchestrator;
- scouts before expensive exploration;
- compressed handoffs;
- specialists on demand rather than always active;
- cheaper leaf execution;
- narrow task boundaries;
- short-lived exploration and verification contexts;
- separate test execution and failure diagnosis where useful;
- independent high-quality review;
- constrained communication graph;
- model and effort chosen per role;
- minimize duplicated context and redundant agent activations.

The concrete reference implementation is [`../examples/teams/engineering-context-efficient.yaml`](../examples/teams/engineering-context-efficient.yaml).
