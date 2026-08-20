import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '@claude-team/persistence';
import { FakeAgentProvider, type FakeStep } from '@claude-team/provider';
import { AppCore } from '../src/app-core.js';

/**
 * Raising the budget of a run that ran out, and talking to its agents again.
 *
 * The reported failure, exactly: a run hits its cap, the person raises the
 * budget, comes back, writes to an agent and gets nothing. It looked like a
 * lock. It was three separate things — the run's budget is a snapshot so the
 * team's new number never reached it, nothing could raise a run's own budget,
 * and the refusal was recorded in the timeline instead of being told to the
 * person who had just asked a question.
 */

const REPLY = 'Aqui está a resposta.';

function coreWithSpentRun() {
  const provider = new FakeAgentProvider({
    costPerActivation: 5,
    behaviors: {
      assistant: (ctx: { input: { prompt: string } }) =>
        ctx.input.prompt.includes('writing to you directly')
          ? ([{ kind: 'text', text: REPLY }] as FakeStep[])
          : ([{ kind: 'tool', tool: 'finish', args: { summary: 'feito' } }] as FakeStep[]),
    } as never,
  });
  return { provider, app: new AppCore({ storage: new InMemoryStorage(), provider }) };
}

async function spentRun() {
  const { app } = coreWithSpentRun();
  await app.init();
  const team = await app.createTeamFromPreset({ presetId: 'solo' });
  const run = await app.startRun({
    teamId: team.id,
    objective: 'Gastar o orçamento',
    budget: { maxCostUsd: 3 },
  });
  await app.waitForRun(run.id);
  return { app, runId: run.id, teamId: team.id, agent: team.agents[0]! };
}

describe('a run that ran out of budget', () => {
  it('says so instead of silently not answering', async () => {
    const { app, runId, agent } = await spentRun();

    await expect(
      app.sendAgentMessage({ runId, from: 'user', to: [agent.id], content: 'Responde?' }),
    ).rejects.toThrow(/cost budget exhausted/i);

    // And it says which budget has to move, because that is the part people
    // get wrong.
    await expect(
      app.sendAgentMessage({ runId, from: 'user', to: [agent.id], content: 'Responde?' }),
    ).rejects.toThrow(/this run's own budget/i);

    // Nothing was stored: no message pretending to have been delivered.
    expect((await app.getRunDetail(runId)).messages).toEqual([]);

    await app.shutdown();
  }, 30_000);

  it('is not fixed by raising the team budget — and says which one to raise', async () => {
    const { app, runId, teamId, agent } = await spentRun();

    await app.updateTeam(teamId, { budget: { maxCostUsd: 500, maxDurationMinutes: 120 } });
    expect((await app.getRun(runId)).budget).toEqual({ maxCostUsd: 3 });

    await expect(
      app.sendAgentMessage({ runId, from: 'user', to: [agent.id], content: 'E agora?' }),
    ).rejects.toThrow(/team and application budgets do not apply/i);

    await app.shutdown();
  }, 30_000);

  it('answers once the run\'s own budget is raised', async () => {
    const { app, runId, agent } = await spentRun();

    const updated = await app.updateRunBudget(runId, { maxCostUsd: 500, maxDurationMinutes: 120 });
    expect(updated.budget).toEqual({ maxCostUsd: 500, maxDurationMinutes: 120 });
    expect(updated.status).toBe('completed');

    await app.sendAgentMessage({ runId, from: 'user', to: [agent.id], content: 'Responde agora?' });
    await app.waitForReply(runId);

    const detail = await app.getRunDetail(runId);
    const answer = detail.messages.find((m) => m.type === 'answer');
    expect(answer?.content).toBe(REPLY);
    expect(detail.messages.find((m) => m.from === 'user')!.status).toBe('completed');
    // The change is on the record, not a silent edit.
    expect(detail.events.some((e) => /budget changed by the human/i.test(e.summary))).toBe(true);

    await app.shutdown();
  }, 30_000);

  it('still answers a finished run that ran past its clock or its activations', async () => {
    // Neither of these is money, and neither means the run is looping: they are
    // runaway guards for the run's own work, and a question asked afterwards is
    // not that work.
    const { app } = coreWithSpentRun();
    await app.init();
    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const run = await app.startRun({
      teamId: team.id,
      objective: 'Um só passo',
      budget: { maxAgentActivations: 1, maxDurationMinutes: 1 },
    });
    await app.waitForRun(run.id);
    expect((await app.getRun(run.id)).totals.agentActivations).toBeGreaterThanOrEqual(1);

    await app.sendAgentMessage({
      runId: run.id,
      from: 'user',
      to: [team.agents[0]!.id],
      content: 'Pergunta depois do fim',
    });
    await app.waitForReply(run.id);

    expect((await app.getRunDetail(run.id)).messages.some((m) => m.content === REPLY)).toBe(true);

    await app.shutdown();
  }, 30_000);

  it('lets a live run keep going after its budget is raised mid-flight', async () => {
    const provider = new FakeAgentProvider({
      costPerActivation: 2,
      behaviors: {
        architect: () =>
          [
            {
              kind: 'tool',
              tool: 'create_tasks',
              args: { tasks: [{ key: 'a', title: 'Work', assignee: 'backend' }] },
            },
          ] as FakeStep[],
        backend: () => [{ kind: 'wait', ms: 400 }, { kind: 'text', text: 'pronto' }] as FakeStep[],
      } as never,
    });
    const app = new AppCore({ storage: new InMemoryStorage(), provider });
    await app.init();
    const team = await app.createTeamFromPreset({ presetId: 'software-engineering' });
    const run = await app.startRun({
      teamId: team.id,
      objective: 'Trabalho com teto apertado',
      budget: { maxCostUsd: 3 },
    });

    // Raised while it is executing: the live engine has to pick it up, not just
    // the row in the database.
    await app.updateRunBudget(run.id, { maxCostUsd: 400, maxDurationMinutes: 60 });
    const finished = await app.waitForRun(run.id);

    expect(finished.error ?? '').not.toMatch(/cost budget/i);
    expect(finished.totals.costUsd).toBeGreaterThan(3);

    await app.shutdown();
  }, 30_000);

  it('refuses a run budget that would never stop the run', async () => {
    const { app, runId } = await spentRun();
    await expect(app.updateRunBudget(runId, {})).rejects.toThrow(/must still stop/i);
    await app.shutdown();
  }, 30_000);
});
