import type { AppCore } from '@claude-team/core';
import { Hono } from 'hono';
import { respondWithError } from './errors.js';
import { agentRoutes } from './routes/agents.js';
import { collaborationRoutes } from './routes/collaboration.js';
import { overviewRoutes } from './routes/overview.js';
import { runRoutes } from './routes/runs.js';
import { settingsRoutes } from './routes/settings.js';
import { streamRoutes } from './routes/stream.js';
import { teamRoutes } from './routes/teams.js';
import { staticClient } from './static-files.js';

export interface ServerAppOptions {
  /** Directory of the built client; omitted in development (Vite serves it). */
  clientDir?: string;
  startedAt?: number;
}

/**
 * Assembles the HTTP surface.
 *
 * Every handler underneath is a delegation to `AppCore`; the only logic that
 * lives at this layer is transport concern: routing, status codes and SSE.
 */
export function createServerApp(core: AppCore, options: ServerAppOptions = {}): Hono {
  const startedAt = options.startedAt ?? Date.now();
  const app = new Hono();

  app.onError((err, c) => respondWithError(c, err));

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      service: '@claude-team/web',
      provider: core.provider.id,
      storage: core.storage.describe(),
      activeRuns: core.runs.activeRunIds().length,
      uptimeMs: Date.now() - startedAt,
    }),
  );

  app.route('/', streamRoutes(core));
  app.route('/', overviewRoutes(core));
  app.route('/', settingsRoutes(core));
  app.route('/', teamRoutes(core));
  app.route('/', agentRoutes(core));
  app.route('/', runRoutes(core));
  app.route('/', collaborationRoutes(core));

  app.all('/api/*', (c) =>
    c.json({ error: { code: 'not_found', message: `No such endpoint: ${c.req.path}` } }, 404),
  );

  if (options.clientDir) app.use('*', staticClient(options.clientDir));

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'not_found',
          message: 'The client build is missing. Run `pnpm --filter @claude-team/web build`.',
        },
      },
      404,
    ),
  );

  return app;
}
