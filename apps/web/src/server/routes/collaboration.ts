import type { AppCore } from '@claude-team/core';
import { routes } from '@claude-team/protocol';
import { Hono } from 'hono';

/** Human-authored messages into a run, and human-in-the-loop approvals. */
export function collaborationRoutes(core: AppCore): Hono {
  const app = new Hono();

  app.post(routes.messages(), async (c) => c.json(await core.sendAgentMessage(await c.req.json())));

  app.post(routes.approvalDecision(), async (c) =>
    c.json(await core.resolveApproval(await c.req.json())),
  );

  app.get('/api/approvals', async (c) =>
    c.json(await core.listPendingApprovals(c.req.query('runId'))),
  );

  return app;
}
