import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '@claude-team/persistence';
import { FakeAgentProvider, type FakeStep } from '@claude-team/provider';
import { AppCore } from '../src/app-core.js';

/**
 * Writing to an agent, usually after the run is over.
 *
 * The bug this covers: sending a message persisted a row and told you it was
 * "delivered", and then nothing happened — no agent was ever activated, so no
 * answer could exist. A finished run has to reopen, keep the agent's own
 * session, and answer.
 */

const FINISH: FakeStep[] = [{ kind: 'tool', tool: 'finish', args: { summary: 'All done.' } }];

async function finishedRun(behaviors?: Record<string, unknown>) {
  const provider = new FakeAgentProvider({
    behaviors: {
      assistant: (ctx: { input: { prompt: string } }) =>
        ctx.input.prompt.includes('writing to you directly')
          ? ([{ kind: 'text', text: 'Sim: usei Redis porque a sessão é curta.' }] as FakeStep[])
          : FINISH,
      ...behaviors,
    } as never,
  });
  const app = new AppCore({ storage: new InMemoryStorage(), provider });
  await app.init();
  const team = await app.createTeamFromPreset({ presetId: 'solo' });
  const run = await app.startRun({ teamId: team.id, objective: 'Escolher o armazenamento' });
  await app.waitForRun(run.id);
  return { app, provider, runId: run.id, agent: team.agents[0]! };
}

describe('writing to an agent', () => {
  it('gets an answer back on a run that already finished', async () => {
    const { app, runId, agent } = await finishedRun();
    expect((await app.getRun(runId)).status).toBe('completed');

    await app.sendAgentMessage({
      runId,
      from: 'user',
      to: [agent.handle],
      content: 'Por que Redis e não Postgres?',
    });
    await app.waitForReply(runId);

    const detail = await app.getRunDetail(runId);
    const answer = detail.messages.find((m) => m.type === 'answer' && m.to.includes('user'));
    expect(answer, 'the agent must actually reply').toBeDefined();
    expect(answer!.content).toContain('Redis');
    expect(answer!.from).toBe(agent.id);

    // Your message is marked handled rather than left pending for ever.
    const mine = detail.messages.find((m) => m.from === 'user')!;
    expect(mine.status).toBe('completed');

    await app.shutdown();
  }, 30_000);

  it('answers in the agent\'s own session, so it still knows the run', async () => {
    const { app, provider, runId, agent } = await finishedRun();
    const sessionDuringRun = provider.activationsOf(agent.handle).at(-1)!.sessionId;

    await app.sendAgentMessage({ runId, from: 'user', to: [agent.id], content: 'E o cache?' });
    await app.waitForReply(runId);

    const reply = provider.activationsOf(agent.handle).at(-1)!;
    expect(reply.prompt).toContain('E o cache?');
    // The whole point of "keep the context": same conversation, not a new one.
    expect(reply.sessionId).toBeDefined();
    expect(reply.sessionId).toBe(sessionDuringRun ?? reply.sessionId);

    await app.shutdown();
  }, 30_000);

  it('leaves the finished run finished', async () => {
    const { app, runId, agent } = await finishedRun();
    const before = await app.getRun(runId);

    await app.sendAgentMessage({ runId, from: 'user', to: [agent.id], content: 'Obrigado!' });
    await app.waitForReply(runId);

    const after = await app.getRun(runId);
    expect(after.status).toBe('completed');
    expect(after.completedAt).toEqual(before.completedAt);
    // But what the answer cost is still counted.
    expect(after.totals.agentActivations).toBeGreaterThan(before.totals.agentActivations);

    await app.shutdown();
  }, 30_000);

  it('shows the exchange in the timeline and the conversation', async () => {
    const { app, runId, agent } = await finishedRun();
    await app.sendAgentMessage({ runId, from: 'user', to: [agent.id], content: 'Resume em uma linha.' });
    await app.waitForReply(runId);

    const detail = await app.getRunDetail(runId);
    expect(detail.events.some((e) => e.type === 'message_received' && e.data?.fromUser === true)).toBe(true);
    expect(detail.events.some((e) => e.type === 'agent_output')).toBe(true);

    const transcript = (await app.exportRun(runId, { format: 'markdown' })).content;
    expect(transcript).toContain('Resume em uma linha.');
    expect(transcript).toContain('Redis');

    await app.shutdown();
  }, 30_000);

  it('reaches an agent in a run that is still going', async () => {
    const provider = new FakeAgentProvider({
      behaviors: {
        assistant: (ctx: { input: { prompt: string } }) =>
          ctx.input.prompt.includes('writing to you directly')
            ? ([{ kind: 'text', text: 'Vi sua mensagem no meio do trabalho.' }] as FakeStep[])
            : ([{ kind: 'wait', ms: 1500 }, ...FINISH] as FakeStep[]),
      } as never,
    });
    const app = new AppCore({ storage: new InMemoryStorage(), provider });
    await app.init();
    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const run = await app.startRun({ teamId: team.id, objective: 'Trabalho demorado' });

    await app.sendAgentMessage({
      runId: run.id,
      from: 'user',
      to: [team.agents[0]!.id],
      content: 'Está tudo bem?',
    });
    await app.waitForRun(run.id);
    await app.waitForReply(run.id);

    const detail = await app.getRunDetail(run.id);
    expect(detail.messages.some((m) => m.type === 'answer' && m.content.includes('Vi sua mensagem'))).toBe(
      true,
    );

    await app.shutdown();
  }, 30_000);

  it('reports a failure instead of leaving you waiting for nothing', async () => {
    const { app, runId, agent } = await finishedRun({
      assistant: (ctx: { input: { prompt: string } }) =>
        ctx.input.prompt.includes('writing to you directly')
          ? ([{ kind: 'fail', message: 'provider exploded' }] as FakeStep[])
          : FINISH,
    });

    await app.sendAgentMessage({ runId, from: 'user', to: [agent.id], content: 'Responde?' });
    await app.waitForReply(runId);

    const detail = await app.getRunDetail(runId);
    expect(detail.messages.find((m) => m.from === 'user')!.status).toBe('failed');
    expect(
      detail.events.some((e) => e.level === 'error' && /could not answer you/i.test(e.summary)),
    ).toBe(true);

    await app.shutdown();
  }, 30_000);
});
