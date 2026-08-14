import type { AppCore } from '@claude-team/core';
import { Hono } from 'hono';

/**
 * Runs. Lifecycle transitions are the run manager's business — these handlers
 * only choose which core method the URL means.
 */
export function runRoutes(core: AppCore): Hono {
  const app = new Hono();

  app.get('/api/runs', async (c) => c.json(await core.listRuns({ teamId: c.req.query('teamId') })));
  app.post('/api/runs', async (c) => c.json(await core.startRun(await c.req.json())));

  app.post('/api/runs/:id/start', async (c) => c.json(await core.startQueuedRun(c.req.param('id'))));
  app.post('/api/runs/:id/pause', async (c) => c.json(await core.pauseRun(c.req.param('id'))));
  app.post('/api/runs/:id/resume', async (c) => c.json(await core.resumeRun(c.req.param('id'))));
  app.post('/api/runs/:id/cancel', async (c) => c.json(await core.cancelRun(c.req.param('id'))));
  app.post('/api/runs/:id/retry', async (c) => c.json(await core.retryRun(c.req.param('id'))));

  app.get('/api/runs/:id/events', async (c) => {
    const afterSeq = Number(c.req.query('afterSeq') ?? 0);
    return c.json(await core.listRunEvents(c.req.param('id'), Number.isFinite(afterSeq) ? afterSeq : 0));
  });
  app.get('/api/runs/:id/messages', async (c) => c.json(await core.listMessages(c.req.param('id'))));
  app.get('/api/runs/:id/tasks', async (c) => c.json(await core.listTasks(c.req.param('id'))));

  app.get('/api/runs/:id', async (c) => c.json(await core.getRunDetail(c.req.param('id'))));

  return app;
}
