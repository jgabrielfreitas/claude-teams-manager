import type { AppCore } from '@claude-team/core';
import type { AgentEffort } from '@claude-team/domain';
import { Hono } from 'hono';

/**
 * Teams. Static sub-paths are registered before `/:id` so they win the match.
 */
export function teamRoutes(core: AppCore): Hono {
  const app = new Hono();

  app.post('/api/teams/from-preset', async (c) => {
    const body = (await c.req.json()) as {
      presetId: string;
      name?: string;
      workspace?: string;
      overrides?: Record<string, { model?: string; effort?: AgentEffort }>;
    };
    return c.json(await core.createTeamFromPreset(body));
  });

  app.post('/api/teams/import', async (c) => {
    const body = (await c.req.json()) as { yaml: string; name?: string };
    return c.json(await core.importTeam(body.yaml ?? '', { name: body.name }));
  });

  app.get('/api/teams', async (c) => c.json(await core.listTeams()));
  app.post('/api/teams', async (c) => c.json(await core.createTeam(await c.req.json())));

  app.get('/api/teams/:id/export', async (c) =>
    c.json({ yaml: await core.exportTeam(c.req.param('id')) }),
  );

  app.post('/api/teams/:id/duplicate', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    return c.json(await core.duplicateTeam(c.req.param('id'), body?.name));
  });

  app.get('/api/teams/:id', async (c) => c.json(await core.getTeam(c.req.param('id'))));
  app.patch('/api/teams/:id', async (c) =>
    c.json(await core.updateTeam(c.req.param('id'), await c.req.json())),
  );
  app.delete('/api/teams/:id', async (c) => {
    await core.deleteTeam(c.req.param('id'));
    return c.json({ ok: true } as const);
  });

  return app;
}
