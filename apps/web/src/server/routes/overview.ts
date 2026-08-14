import type { AppCore } from '@claude-team/core';
import { routes } from '@claude-team/protocol';
import { Hono } from 'hono';

/**
 * Dashboard, activity, search and the static catalogs.
 *
 * Every handler is a one-line delegation to the core: the aggregation that
 * builds a dashboard is a use case, not a controller concern (ADR-001).
 */
export function overviewRoutes(core: AppCore): Hono {
  const app = new Hono();

  app.get(routes.dashboard(), async (c) => c.json(await core.getDashboard()));

  app.get('/api/activity', async (c) => {
    const limit = Number(c.req.query('limit') ?? 100);
    return c.json(await core.recentActivity(Number.isFinite(limit) ? limit : 100));
  });

  app.get('/api/search', async (c) => {
    const query = c.req.query('q') ?? '';
    return c.json(await core.search(query));
  });

  app.get(routes.catalog(), async (c) =>
    c.json({
      models: await core.listModelsInUse(),
      efforts: core.listEfforts(),
      toolGroups: core.listToolGroups(),
      templates: core.listTemplates().map((t) => ({
        id: t.id,
        name: t.name,
        role: t.role,
        description: t.description,
        model: t.model,
        effort: t.effort,
        category: t.category,
        handle: t.handle,
        orchestratorCapable: t.orchestratorCapable,
      })),
      presets: core.listPresets(),
      providers: core.listProviders(),
    }),
  );

  return app;
}
