import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '@claude-team/persistence';
import { FakeAgentProvider, type FakeStep } from '@claude-team/provider';
import { AppCore } from '../src/app-core.js';
import type { AppEvent } from '../src/event-bus.js';

/**
 * Deleting a run.
 *
 * Both surfaces advertised a delete key long before anything implemented it,
 * so the option existed and did nothing. What matters here is that it really
 * removes the history, that it refuses while the engine is holding the run,
 * and that it announces itself — a surface showing a run that no longer exists
 * is the same class of bug as a key that does nothing.
 */

const DONE: FakeStep[] = [{ kind: 'tool', tool: 'finish', args: { summary: 'done' } }];

async function coreWithRun() {
  const app = new AppCore({
    storage: new InMemoryStorage(),
    provider: new FakeAgentProvider({ behaviors: { assistant: DONE } as never }),
  });
  await app.init();
  const team = await app.createTeamFromPreset({ presetId: 'solo' });
  const run = await app.startRun({ teamId: team.id, objective: 'Something to delete' });
  await app.waitForRun(run.id);
  return { app, teamId: team.id, runId: run.id };
}

describe('deleting a run', () => {
  it('removes the run and everything under it, leaving the team alone', async () => {
    const { app, teamId, runId } = await coreWithRun();

    const before = await app.getRunDetail(runId);
    expect(before.events.length).toBeGreaterThan(0);

    await app.deleteRun(runId);

    await expect(app.getRun(runId)).rejects.toThrow(/not found/i);
    expect(await app.listRuns()).toEqual([]);
    // The cascade reached the children, not just the row.
    expect(await app.listTasks(runId)).toEqual([]);
    expect(await app.listMessages(runId)).toEqual([]);
    // The team and its agents survive: this deletes a conversation, not a team.
    const team = await app.getTeam(teamId);
    expect(team.agents.length).toBeGreaterThan(0);

    await app.shutdown();
  }, 30_000);

  it('announces the deletion so every open surface stops showing it', async () => {
    const { app, runId } = await coreWithRun();
    const seen: AppEvent[] = [];
    app.subscribe((event) => seen.push(event));

    await app.deleteRun(runId);

    expect(seen).toContainEqual({ type: 'run.deleted', runId });

    await app.shutdown();
  }, 30_000);

  it('refuses a run that is still executing, and says what to do first', async () => {
    const app = new AppCore({
      storage: new InMemoryStorage(),
      provider: new FakeAgentProvider({
        behaviors: { assistant: [{ kind: 'wait', ms: 3_000 }, ...DONE] } as never,
      }),
    });
    await app.init();
    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const run = await app.startRun({ teamId: team.id, objective: 'Long one' });
    // Guard against the assertion below passing for the wrong reason: it has to
    // be refused because the run is executing, not because it raced the start.
    expect((await app.getRunDetail(run.id)).isActive).toBe(true);

    await expect(app.deleteRun(run.id)).rejects.toThrow(/cancel it before deleting/i);

    // Cancelling is exactly what the message asks for, and then it works.
    await app.cancelRun(run.id);
    await app.deleteRun(run.id);
    expect(await app.listRuns()).toEqual([]);

    await app.shutdown();
  }, 30_000);

  it('rejects a run that does not exist rather than silently doing nothing', async () => {
    const { app, runId } = await coreWithRun();
    await app.deleteRun(runId);
    await expect(app.deleteRun(runId)).rejects.toThrow(/not found/i);
    await app.shutdown();
  }, 30_000);
});
