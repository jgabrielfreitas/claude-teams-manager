# ADR-001 — One application core, two presentations

**Status:** Accepted
**Date:** 2026-08-14

## Context

The product must be usable from a terminal and from a browser. The obvious
failure mode is two codebases that drift: the web learns a validation rule the
TUI never gets, the TUI gets a state transition the web forbids, and after a
few months "the same product" behaves differently depending on where you opened
it.

## Decision

There is exactly one application layer, `@claude-team/core`, exposing every use
case as a method on `AppCore`. Both surfaces call the *same methods*:

- the TUI holds an `AppCore` in-process and calls it directly;
- the web server holds an `AppCore` in-process and its HTTP handlers delegate to
  it one-to-one.

The layering is:

```
apps/tui ─┐
          ├─▶ packages/core ─┬─▶ packages/runtime ─┬─▶ packages/provider
apps/web ─┘                  │                     │
   (client) ─▶ protocol ─────┘                     └─▶ packages/persistence
                                                       packages/domain
```

Supporting rules:

1. **The domain is isomorphic.** `@claude-team/domain` uses Web Crypto rather
   than `node:crypto` and has no other Node dependency, so the browser bundle
   imports the same entities, the same zod schemas, the same `availableRunActions`
   and the same formatting helpers the server uses. There is no parallel "API
   model".
2. **Validation lives in the domain.** `packages/domain/src/validation.ts` holds
   the zod schemas for every input. `AppCore` parses with them; controllers do
   not validate.
3. **Presentation vocabulary is shared too.** `@claude-team/ui-shared` owns
   status labels, tones, formatters and the command catalogue. "Blocked is
   amber" is a product decision, so it is written once and each surface maps
   `Tone` to its own primitive.
4. **The transport is a generated-feeling contract.** `@claude-team/protocol`
   declares the route table and a typed client that mirrors `AppCore` method for
   method, so adding an endpoint fails to compile on both sides until both are
   updated.

## Consequences

- A new use case is written once and appears in both surfaces.
- The web client cannot accidentally take a shortcut through Node-only code:
  it is physically unable to import `@claude-team/core`.
- The cost is indirection: the web server is a thin, almost mechanical layer.
  That is the point — a controller with no logic in it cannot drift.
- A future third surface (an editor extension, a daemon) is additive.

## Alternatives considered

- **Web-first, TUI as a client of the HTTP API.** Rejected: it would force a
  server process to be running for the terminal to work, which is a bad
  experience for a CLI tool, and it makes the TUI's realtime story worse rather
  than better.
- **Shared code by copy.** Rejected for the obvious reason.
