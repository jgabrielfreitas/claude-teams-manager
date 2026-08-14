import type { AppCore } from '@claude-team/core';
import { routes } from '@claude-team/protocol';
import { Hono } from 'hono';

/** Settings, onboarding, provider health and workspace inspection. */
export function settingsRoutes(core: AppCore): Hono {
  const app = new Hono();

  app.get(routes.settings(), async (c) => c.json(await core.getSettings()));
  app.patch(routes.settings(), async (c) => c.json(await core.updateSettings(await c.req.json())));

  app.get(routes.onboardingStatus(), async (c) =>
    c.json({ needed: await core.isOnboardingNeeded(), settings: await core.getSettings() }),
  );

  app.get(routes.onboardingDetect(), async (c) => c.json(await core.detectEnvironment()));
  app.post(routes.onboardingComplete(), async (c) => c.json(await core.completeOnboarding()));
  app.post(routes.providerCheck(), async (c) => c.json(await core.checkProvider()));

  app.get('/api/workspace', async (c) => {
    const path = c.req.query('path') ?? process.cwd();
    return c.json(await core.inspectWorkspace(path));
  });

  return app;
}
