import { TRANSCRIPT_FORMATS, type AppCore, type TranscriptFormat } from '@claude-team/core';
import { invalid } from '@claude-team/domain';
import { Hono } from 'hono';

/**
 * The only rule this file owns: which of the core's formats a query string is
 * allowed to name. The document itself is rendered by `core.exportRun`.
 */
function transcriptFormat(value: string | undefined): TranscriptFormat | undefined {
  if (value === undefined) return undefined;
  if (!(TRANSCRIPT_FORMATS as readonly string[]).includes(value)) {
    throw invalid(`format: expected one of ${TRANSCRIPT_FORMATS.join(', ')}`, { format: value });
  }
  return value as TranscriptFormat;
}

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

  /**
   * The whole run as one document. `download=1` returns the raw body as an
   * attachment; without it the JSON envelope feeds the copy button.
   */
  app.get('/api/runs/:id/export', async (c) => {
    const { content, fileName, mimeType, format } = await core.exportRun(c.req.param('id'), {
      format: transcriptFormat(c.req.query('format')) ?? 'markdown',
      includeDebug: c.req.query('includeDebug') === '1',
    });
    if (c.req.query('download') !== '1') return c.json({ content, fileName, format });
    return c.body(content, 200, {
      'content-type': mimeType,
      'content-disposition': `attachment; filename="${fileName}"`,
    });
  });

  app.get('/api/runs/:id/messages', async (c) => c.json(await core.listMessages(c.req.param('id'))));
  app.get('/api/runs/:id/tasks', async (c) => c.json(await core.listTasks(c.req.param('id'))));

  app.get('/api/runs/:id', async (c) => c.json(await core.getRunDetail(c.req.param('id'))));

  app.patch('/api/runs/:id/budget', async (c) =>
    c.json(await core.updateRunBudget(c.req.param('id'), await c.req.json())),
  );

  app.delete('/api/runs/:id', async (c) => {
    await core.deleteRun(c.req.param('id'));
    return c.json({ ok: true } as const);
  });

  return app;
}
