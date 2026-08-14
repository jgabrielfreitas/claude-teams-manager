import type { AppCore } from '@claude-team/core';
import type { AgentEffort } from '@claude-team/domain';
import { Hono } from 'hono';

/**
 * Agents, including the two first-class per-agent shortcuts (`model`, `effort`)
 * that exist so changing one agent can never touch its teammates.
 */
export function agentRoutes(core: AppCore): Hono {
  const app = new Hono();

  app.post('/api/agents/from-template', async (c) => {
    const body = (await c.req.json()) as {
      teamId: string;
      templateId: string;
      handle?: string;
      name?: string;
      model?: string;
      effort?: AgentEffort;
      canMessage?: string[];
    };
    return c.json(await core.createAgentFromTemplate(body));
  });

  app.get('/api/agents', async (c) => c.json(await core.listAgents(c.req.query('teamId'))));
  app.post('/api/agents', async (c) => c.json(await core.createAgent(await c.req.json())));

  app.get('/api/agents/:id/inspect', async (c) =>
    c.json(await core.inspectAgent(c.req.param('id'), c.req.query('runId'))),
  );

  app.post('/api/agents/:id/model', async (c) => {
    const body = (await c.req.json()) as { model: string };
    return c.json(await core.updateAgentModel(c.req.param('id'), body.model));
  });

  app.post('/api/agents/:id/effort', async (c) => {
    const body = (await c.req.json()) as { effort: AgentEffort };
    return c.json(await core.updateAgentEffort(c.req.param('id'), body.effort));
  });

  app.post('/api/agents/:id/duplicate', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; handle?: string };
    return c.json(await core.duplicateAgent(c.req.param('id'), body ?? {}));
  });

  app.get('/api/agents/:id', async (c) => c.json(await core.getAgent(c.req.param('id'))));
  app.patch('/api/agents/:id', async (c) =>
    c.json(await core.updateAgent(c.req.param('id'), await c.req.json())),
  );
  app.delete('/api/agents/:id', async (c) => {
    await core.deleteAgent(c.req.param('id'));
    return c.json({ ok: true } as const);
  });

  return app;
}
