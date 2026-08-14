import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { claudeTeamHome, createAppCore, type AppCore } from '@claude-team/core';
import { createServerApp } from './app.js';

/**
 * Entry point of the web server.
 *
 * It boots the same `AppCore` the TUI boots — same storage, same runtime, same
 * rules — and puts an HTTP + SSE surface in front of it (ADR-001).
 */

interface Cli {
  dbPath?: string;
  provider?: string;
  port?: number;
  host: string;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { host: process.env.HOST ?? '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--db') cli.dbPath = next();
    else if (arg?.startsWith('--db=')) cli.dbPath = arg.slice('--db='.length);
    else if (arg === '--provider') cli.provider = next();
    else if (arg?.startsWith('--provider=')) cli.provider = arg.slice('--provider='.length);
    else if (arg === '--port') cli.port = Number(next());
    else if (arg?.startsWith('--port=')) cli.port = Number(arg.slice('--port='.length));
    else if (arg === '--host') cli.host = next() ?? cli.host;
  }
  return cli;
}

function clientDir(): string | undefined {
  // Both `dist/server/index.js` and `src/server/index.ts` sit two levels above
  // the package root, so one expression covers the built and the dev layout.
  const here = dirname(fileURLToPath(import.meta.url));
  const built = resolve(here, '../../dist/client');
  return existsSync(resolve(built, 'index.html')) ? built : undefined;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  const core: AppCore = await createAppCore({
    dbPath: cli.dbPath,
    provider: cli.provider,
    // Demo mode: deterministic, token-free agent output.
    providerOptions:
      cli.provider === 'fake'
        ? ({ latencyMs: 120 } as Record<string, unknown>)
        : undefined,
  });

  const settings = await core.getSettings();
  const port = cli.port ?? Number(process.env.PORT ?? settings.webPort);
  const dist = clientDir();

  const app = createServerApp(core, { clientDir: dist, startedAt });

  const server = serve({ fetch: app.fetch, port, hostname: cli.host }, (info) => {
    const url = `http://${cli.host === '0.0.0.0' ? 'localhost' : cli.host}:${info.port}`;
    const storage = core.storage.describe();
    process.stdout.write(
      [
        '',
        `  claude-team web  ${url}`,
        `  provider         ${core.provider.id}`,
        `  storage          ${storage.driver} · ${storage.location === ':memory:' ? 'in memory' : storage.location}`,
        `  home             ${claudeTeamHome()}`,
        `  client           ${dist ?? 'served by vite (dev)'}`,
        '',
      ].join('\n'),
    );
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`\n  ${signal} received — shutting down…\n`);
    server.close();
    await core.shutdown().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  process.stderr.write(`Failed to start: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
