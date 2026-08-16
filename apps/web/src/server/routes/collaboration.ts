import type { AppCore } from '@claude-team/core';
import { routes } from '@claude-team/protocol';
import { Hono } from 'hono';

/**
 * The three ways a human takes part in a run: writing to an agent, approving an
 * action, and answering a question.
 *
 * Approvals and questions are separate on purpose — an approval returns yes or
 * no, a question returns content the agent then works from.
 */
export function collaborationRoutes(core: AppCore): Hono {
  const app = new Hono();

  app.post(routes.messages(), async (c) => c.json(await core.sendAgentMessage(await c.req.json())));

  app.post(routes.approvalDecision(), async (c) =>
    c.json(await core.resolveApproval(await c.req.json())),
  );

  app.get('/api/approvals', async (c) =>
    c.json(await core.listPendingApprovals(c.req.query('runId'))),
  );

  app.post(routes.questionAnswer(), async (c) =>
    c.json(await core.answerQuestion(await c.req.json())),
  );

  app.get('/api/questions', async (c) =>
    c.json(await core.listPendingQuestions(c.req.query('runId'))),
  );

  return app;
}
