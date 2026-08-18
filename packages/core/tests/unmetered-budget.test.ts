import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '@claude-team/persistence';
import { FakeAgentProvider, type FakeStep } from '@claude-team/provider';
import { DEFAULT_BUDGET, describeBudget, emptyUsage } from '@claude-team/domain';
import { BudgetTracker } from '@claude-team/runtime';
import { AppCore } from '../src/app-core.js';

/**
 * Running a team unmetered.
 *
 * The point of the feature is that spend never stops the run — the work is
 * worth what it costs — so what these assert is the other half: that the run
 * still stops, and stops for the reason the team chose.
 */

const PLAN: FakeStep[] = [
  {
    kind: 'tool',
    tool: 'create_tasks',
    args: { tasks: [{ key: 'a', title: 'Work', assignee: 'backend' }] },
  },
];

describe('a team running without a budget', () => {
  it('spends past any cap, and stops on interactions instead', async () => {
    const provider = new FakeAgentProvider({
      // Each activation costs more than the old default cap in one go.
      costPerActivation: 50,
      behaviors: { architect: () => PLAN } as never,
    });
    const core = new AppCore({ storage: new InMemoryStorage(), provider });
    await core.init();

    const team = await core.createTeamFromPreset({ presetId: 'software-engineering' });
    const run = await core.startRun({
      teamId: team.id,
      objective: 'Cost is not the constraint here',
      budget: { maxAgentActivations: 2, maxDurationMinutes: 30 },
    });
    const finished = await core.waitForRun(run.id);

    // It spent five times the default cap without anything objecting…
    expect(finished.totals.costUsd).toBeGreaterThan(DEFAULT_BUDGET.maxCostUsd!);
    // …and stopped for the reason the team actually chose.
    expect(finished.status).toBe('failed');
    expect(finished.error).toMatch(/activation budget/i);
    expect(finished.error).not.toMatch(/cost|token/i);

    const detail = await core.getRunDetail(run.id);
    expect(
      detail.events.some((e) => e.type === 'budget_exceeded' && /activation/i.test(e.summary)),
    ).toBe(true);

    await core.shutdown();
  }, 30_000);

  it('still stops on time, and never on money, when running unmetered', () => {
    // Asserted on the tracker rather than through a run: the smallest time
    // limit the API accepts is a minute, and a test that waits one is a test
    // nobody runs.
    const startedAt = Date.now();
    const tracker = new BudgetTracker(
      { maxDurationMinutes: 30, maxAgentActivations: 100 },
      startedAt,
    );

    tracker.recordActivation({ ...emptyUsage(), inputTokens: 50_000_000 }, 5_000);
    expect(tracker.exceeded(startedAt + 60_000)).toBeUndefined();

    expect(tracker.exceeded(startedAt + 31 * 60_000)).toMatch(/time budget/i);
  });

  it('refuses a budget with nothing to stop it, wherever it comes from', async () => {
    const core = new AppCore({
      storage: new InMemoryStorage(),
      provider: new FakeAgentProvider({ behaviors: { assistant: [] } as never }),
    });
    await core.init();
    const team = await core.createTeamFromPreset({ presetId: 'solo' });

    await expect(
      core.startRun({ teamId: team.id, objective: 'For ever', budget: {} }),
    ).rejects.toThrow(/must still stop/i);
    await expect(core.updateTeam(team.id, { budget: {} })).rejects.toThrow(/must still stop/i);

    await core.shutdown();
  }, 30_000);

  it('treats a team with no budget as "use the default", not as "no limits"', async () => {
    const core = new AppCore({
      storage: new InMemoryStorage(),
      provider: new FakeAgentProvider({
        behaviors: { assistant: [{ kind: 'tool', tool: 'finish', args: { summary: 'ok' } }] } as never,
      }),
    });
    await core.init();

    const team = await core.createTeamFromPreset({ presetId: 'solo' });
    await core.updateTeam(team.id, { budget: null });
    expect((await core.getTeam(team.id)).budget).toBeUndefined();

    const run = await core.startRun({ teamId: team.id, objective: 'Inherit the default' });
    await core.waitForRun(run.id);

    const settings = await core.getSettings();
    expect((await core.getRun(run.id)).budget).toEqual(settings.defaultBudget);

    await core.shutdown();
  }, 30_000);

  it('keeps the unmetered choice on the team, and says so', async () => {
    const core = new AppCore({
      storage: new InMemoryStorage(),
      provider: new FakeAgentProvider({
        behaviors: { assistant: [{ kind: 'tool', tool: 'finish', args: { summary: 'ok' } }] } as never,
      }),
    });
    await core.init();

    const team = await core.createTeamFromPreset({ presetId: 'solo' });
    await core.updateTeam(team.id, {
      budget: { maxDurationMinutes: 240, maxAgentActivations: 200 },
    });

    const stored = (await core.getTeam(team.id)).budget;
    expect(stored).toEqual({ maxDurationMinutes: 240, maxAgentActivations: 200 });
    expect(describeBudget(stored)).toBe('no spend cap · 240 min · 200 interactions');

    // And the run inherits it rather than falling back to the metered default.
    const run = await core.startRun({ teamId: team.id, objective: 'Go' });
    expect((await core.getRun(run.id)).budget).toEqual(stored);

    await core.waitForRun(run.id);
    await core.shutdown();
  }, 30_000);
});
