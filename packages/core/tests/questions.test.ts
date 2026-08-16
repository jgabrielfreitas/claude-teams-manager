import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '@claude-team/persistence';
import { FakeAgentProvider, resolveToolGrants, type FakeStep } from '@claude-team/provider';
import { defaultToolPermissions } from '@claude-team/domain';
import { AppCore } from '../src/app-core.js';
import type { AppEvent } from '../src/event-bus.js';

/**
 * An agent asking the human something it cannot decide alone.
 *
 * This exists because the alternative failed in the field: the provider's own
 * ask-the-user tool was treated as an unknown capability, so the human was
 * shown a *permission* prompt ("allow once / always / deny"), granted it, and
 * the agent then waited forever for an answer nobody had been asked to give.
 */

function coreWith(steps: Record<string, FakeStep[]>, settings?: Record<string, unknown>) {
  const provider = new FakeAgentProvider({ behaviors: steps as never });
  const app = new AppCore({
    storage: new InMemoryStorage(),
    provider,
    engineOptions: { questionTimeoutMs: 3_000 } as never,
  });
  return { app, provider, settings };
}

const ASK: FakeStep = {
  kind: 'tool',
  tool: 'ask_user',
  args: {
    header: 'Niche',
    question: 'Which niche should the page target?',
    options: [
      { label: 'Weddings', description: 'High ticket, seasonal' },
      { label: 'Home office', description: 'Steady, competitive' },
    ],
  },
};

async function waitForQuestion(events: AppEvent[]): Promise<string> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const pending = events
      .filter((e): e is Extract<AppEvent, { type: 'question' }> => e.type === 'question')
      .find((e) => e.question.status === 'pending');
    if (pending) return pending.question.id;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('No question was ever asked');
}

describe('an agent asking the human', () => {
  it('parks the agent, then hands it the chosen option', async () => {
    const { app } = coreWith({
      assistant: [
        ASK,
        { kind: 'tool', tool: 'finish', args: { summary: 'Plan built on the chosen niche.' } },
      ],
    });
    await app.init();

    const events: AppEvent[] = [];
    app.subscribe((e) => events.push(e));

    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const run = await app.startRun({ teamId: team.id, objective: 'Plan a longtail page' });

    const questionId = await waitForQuestion(events);
    const stored = (await app.listQuestions(run.id))[0];
    expect(stored.header).toBe('Niche');
    expect(stored.options.map((o) => o.label)).toEqual(['Weddings', 'Home office']);
    // With options offered, typing is not the default way to answer.
    expect(stored.allowFreeform).toBe(false);
    expect(stored.status).toBe('pending');

    // It is a question, not an approval — the approval queue stays empty.
    expect(await app.listPendingApprovals()).toEqual([]);
    expect((await app.listPendingQuestions()).map((q) => q.id)).toEqual([questionId]);

    await app.answerQuestion({ questionId, selected: ['Weddings'] });

    const finished = await app.waitForRun(run.id);
    expect(finished.status).toBe('completed');

    const answered = (await app.listQuestions(run.id))[0];
    expect(answered.status).toBe('answered');
    expect(answered.answer).toContain('Weddings');
    expect(answered.answeredBy).toBe('user');

    // And the agent actually received it.
    const detail = await app.getRunDetail(run.id);
    const toolResult = detail.events.find(
      (e) => e.type === 'tool_result' && String(e.data.summary ?? '').includes('Weddings'),
    );
    expect(toolResult).toBeDefined();

    await app.shutdown();
  }, 20_000);

  it('accepts a typed answer when the agent offers no options', async () => {
    const { app } = coreWith({
      assistant: [
        { kind: 'tool', tool: 'ask_user', args: { question: 'What is the monthly budget?' } },
        { kind: 'tool', tool: 'finish', args: { summary: 'Done.' } },
      ],
    });
    await app.init();
    const events: AppEvent[] = [];
    app.subscribe((e) => events.push(e));

    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const run = await app.startRun({ teamId: team.id, objective: 'Plan' });
    const questionId = await waitForQuestion(events);

    const stored = (await app.listQuestions(run.id))[0];
    expect(stored.options).toEqual([]);
    expect(stored.allowFreeform).toBe(true);

    await app.answerQuestion({ questionId, text: 'R$ 3.000 per month' });
    await app.waitForRun(run.id);

    expect((await app.listQuestions(run.id))[0].answer).toContain('R$ 3.000');
    await app.shutdown();
  }, 20_000);

  it('rejects an answer that does not match what was asked', async () => {
    const { app } = coreWith({
      assistant: [ASK, { kind: 'tool', tool: 'finish', args: { summary: 'Done.' } }],
    });
    await app.init();
    const events: AppEvent[] = [];
    app.subscribe((e) => events.push(e));

    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const run = await app.startRun({ teamId: team.id, objective: 'Plan' });
    const questionId = await waitForQuestion(events);

    await expect(app.answerQuestion({ questionId, selected: ['Crypto'] })).rejects.toThrow(
      /not one of the offered options/i,
    );
    await expect(
      app.answerQuestion({ questionId, selected: ['Weddings', 'Home office'] }),
    ).rejects.toThrow(/single choice/i);
    await expect(app.answerQuestion({ questionId })).rejects.toThrow(/pick an option or type/i);

    // The question is still open after the invalid attempts.
    expect((await app.listPendingQuestions()).map((q) => q.id)).toEqual([questionId]);

    await app.answerQuestion({ questionId, selected: ['Home office'] });
    await app.waitForRun(run.id);
    await app.shutdown();
  }, 20_000);

  it('auto mode answers instead of blocking, and says so', async () => {
    const { app } = coreWith({
      assistant: [ASK, { kind: 'tool', tool: 'finish', args: { summary: 'Decided alone.' } }],
    });
    await app.init();
    await app.updateSettings({ autoAnswerQuestions: true, autoApproveAll: true });

    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const run = await app.startRun({ teamId: team.id, objective: 'Plan' });

    // No human ever answers, and the run still finishes.
    const finished = await app.waitForRun(run.id);
    expect(finished.status).toBe('completed');

    const question = (await app.listQuestions(run.id))[0];
    expect(question.status).toBe('skipped');
    expect(question.answeredBy).toBe('auto');
    expect(question.answer).toMatch(/no human is available/i);
    expect(question.answer).toMatch(/state.*assumption/i);

    await app.shutdown();
  }, 20_000);

  it('does not hang for ever when nobody answers', async () => {
    const { app } = coreWith({
      assistant: [ASK, { kind: 'tool', tool: 'finish', args: { summary: 'Carried on.' } }],
    });
    await app.init();

    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const run = await app.startRun({ teamId: team.id, objective: 'Plan' });

    const finished = await app.waitForRun(run.id);
    expect(finished.status).toBe('completed');

    const question = (await app.listQuestions(run.id))[0];
    expect(question.status).toBe('expired');
    expect(question.answeredBy).toBe('timeout');
    expect(question.answer).toMatch(/nobody answered/i);

    await app.shutdown();
  }, 25_000);
});

describe('the provider never offers its own ask-the-user tool', () => {
  it('removes AskUserQuestion from every agent, whatever its capabilities', () => {
    const grants = resolveToolGrants(defaultToolPermissions(), ['mcp__team__ask_user']);

    // This is the tool that was being mistaken for an unknown capability and
    // routed into the approval gate.
    expect(grants.disallowedTools).toContain('AskUserQuestion');
    expect(grants.allowedTools).not.toContain('AskUserQuestion');
    expect(grants.askTools).not.toContain('AskUserQuestion');

    // Our own question tool is there instead.
    expect(grants.allowedTools).toContain('mcp__team__ask_user');
  });

  it('hands ask_user to every agent, orchestrator or not', async () => {
    const { app, provider } = coreWith({
      architect: [
        {
          kind: 'tool',
          tool: 'create_tasks',
          args: { tasks: [{ key: 'a', title: 'Work', assignee: 'backend' }] },
        },
      ],
      backend: [{ kind: 'text', text: 'done' }],
    });
    await app.init();

    const team = await app.createTeamFromPreset({ presetId: 'software-engineering' });
    const run = await app.startRun({ teamId: team.id, objective: 'Anything' });
    await app.waitForRun(run.id);

    expect(provider.activationsOf('architect')[0].customToolNames).toContain('ask_user');
    expect(provider.activationsOf('backend')[0].customToolNames).toContain('ask_user');

    await app.shutdown();
  }, 20_000);
});
