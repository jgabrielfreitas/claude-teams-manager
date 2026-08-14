import React from 'react';
import { readFile } from 'node:fs/promises';
import { render, type Instance } from 'ink';
import { createAppCore, type AppCore } from '@claude-team/core';
import { isDomainError } from '@claude-team/domain';
import { App } from './App.js';
import { UiProvider } from './store.js';
import { RunLive } from './cli/RunLive.js';
import { HELP_TEXT, parseArgs } from './cli/args.js';
import { agentList, runList, teamExport, teamImport, teamList } from './cli/commands.js';

/**
 * Entry point for the `claude-team` binary.
 *
 * Arguments are handled before anything is rendered, so scripted use
 * (`team export`, `team list`) never pays for the interface.
 */

/* ------------------------------------------------------------------ *
 * Last resort
 * ------------------------------------------------------------------ */

/** Whatever Ink is currently driving, so a crash can give the terminal back. */
let inkInstance: Instance | undefined;

/** Set once the core is open: lets the handler close storage before exiting. */
let shutdownHook: ((code: number) => Promise<void>) | undefined;

/**
 * Puts the terminal back the way we found it: raw mode off, cursor visible,
 * Ink no longer holding the screen. Called before we print anything on a
 * failure — a stack trace over a half-rendered frame in raw mode leaves the
 * user with a shell that does not echo.
 */
function restoreTerminal(): void {
  try {
    inkInstance?.unmount();
  } catch {
    /* the terminal matters more than why unmounting failed */
  }
  inkInstance = undefined;
  const stdin = process.stdin;
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    try {
      stdin.setRawMode(false);
    } catch {
      /* nothing left to try */
    }
  }
  if (process.stdout.isTTY) process.stdout.write('\u001B[?25h');
}

/**
 * Every action already reports its own failures (`ui.guard`, `ui.dispatch`).
 * This is the net under those: without it, Node ≥ 15 kills the process on an
 * unhandled rejection, which mid-render means a terminal stuck in raw mode.
 */
function bail(reason: unknown): void {
  restoreTerminal();
  process.stderr.write(
    `claude-team: unhandled error — ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
  );
  if (shutdownHook) void shutdownHook(1);
  else process.exit(1);
}

function installLastResortHandler(): void {
  process.on('unhandledRejection', (reason: unknown) => bail(reason));
}

async function version(): Promise<string> {
  try {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  installLastResortHandler();
  const args = parseArgs(process.argv.slice(2));

  if (args.errors.length > 0) {
    for (const error of args.errors) process.stderr.write(`${error}\n`);
    process.stderr.write('\nRun `claude-team --help`.\n');
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  if (args.version) {
    process.stdout.write(`claude-team ${await version()}\n`);
    return;
  }

  let core: AppCore;
  try {
    core = await createAppCore({ dbPath: args.db, provider: args.provider });
  } catch (err) {
    process.stderr.write(`Could not open claude-team: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  const settings = await core.getSettings();
  const providerId = args.provider ?? settings.provider;

  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await core.shutdown();
    } catch {
      /* nothing useful to do while exiting */
    }
    process.exit(code);
  };
  shutdownHook = shutdown;
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  try {
    const [command, ...rest] = args.positional;

    /* ---------------- scripted commands ---------------- */

    if (command === 'team' || command === 'teams') {
      const sub = rest[0];
      if (sub === 'list' || sub === undefined) {
        process.exitCode = await teamList(core);
      } else if (sub === 'export') {
        if (!rest[1]) {
          process.stderr.write('Usage: claude-team team export <name-or-id>\n');
          process.exitCode = 2;
        } else {
          process.exitCode = await teamExport(core, rest[1]);
        }
      } else if (sub === 'import') {
        if (!rest[1]) {
          process.stderr.write('Usage: claude-team team import <file.yaml>\n');
          process.exitCode = 2;
        } else {
          process.exitCode = await teamImport(core, rest[1]);
        }
      } else {
        process.stderr.write(`Unknown team command "${sub}". Try list, export, import.\n`);
        process.exitCode = 2;
      }
      await shutdown(process.exitCode ?? 0);
      return;
    }

    if (command === 'agent' || command === 'agents') {
      const sub = rest[0];
      if (sub === 'list' || sub === undefined) {
        process.exitCode = await agentList(core);
      } else {
        process.stderr.write(`Unknown agent command "${sub}". Try list.\n`);
        process.exitCode = 2;
      }
      await shutdown(process.exitCode ?? 0);
      return;
    }

    /* ---------------- run ---------------- */

    if (command === 'run') {
      const objective = rest.join(' ').trim();
      if (!objective) {
        if (rest.length === 0 && args.team === undefined) {
          process.exitCode = await runList(core);
          await shutdown(process.exitCode ?? 0);
          return;
        }
        process.stderr.write('Usage: claude-team run "<objective>" [--team <name>]\n');
        await shutdown(2);
        return;
      }

      const teams = await core.listTeams();
      if (teams.length === 0) {
        process.stderr.write('There are no teams yet. Run `claude-team` to create one.\n');
        await shutdown(1);
        return;
      }
      // `findTeam` decides what a typed reference means (id, name, prefix) and
      // says precisely why it could not — including an ambiguous prefix.
      const team = args.team ? await core.findTeam(args.team) : teams[0];

      let runId: string;
      try {
        const run = await core.startRun({ teamId: team.id, objective });
        runId = run.id;
      } catch (err) {
        process.stderr.write(`Could not start the run: ${err instanceof Error ? err.message : String(err)}\n`);
        await shutdown(1);
        return;
      }

      const live = render(
        <UiProvider core={core} providerId={providerId} initialSelection={{ runId, teamId: team.id }}>
          <RunLive runId={runId} />
        </UiProvider>,
      );
      inkInstance = live;
      await live.waitUntilExit();
      inkInstance = undefined;

      const final = await core.getRun(runId).catch(() => undefined);
      await shutdown(final && final.status !== 'completed' ? 1 : 0);
      return;
    }

    if (command !== undefined) {
      process.stderr.write(`Unknown command "${command}".\n\n${HELP_TEXT}`);
      await shutdown(2);
      return;
    }

    /* ---------------- full interface ---------------- */

    const onboarding = await core.isOnboardingNeeded();
    const instance = render(
      <UiProvider core={core} providerId={providerId} initialOnboarding={onboarding}>
        <App />
      </UiProvider>,
      { exitOnCtrlC: true },
    );
    inkInstance = instance;
    await instance.waitUntilExit();
    inkInstance = undefined;
    await shutdown(0);
  } catch (err) {
    // A domain failure is a message for the user ("no team matches…",
    // "matches 3 teams: …"); anything else is a bug and keeps its stack.
    restoreTerminal();
    process.stderr.write(
      `${isDomainError(err) ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    await shutdown(1);
  }
}

void main().catch(bail);
