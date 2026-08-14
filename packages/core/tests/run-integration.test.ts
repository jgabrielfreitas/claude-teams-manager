import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '@claude-team/persistence';
import { FakeAgentProvider, type FakeStep } from '@claude-team/provider';
import { AppCore } from '../src/app-core.js';

/**
 * End-to-end exercise of the whole runtime against the deterministic provider:
 * orchestration, delegation, the task DAG, agent-to-agent messaging (both
 * modes), review, per-agent model/effort, budgets and persistence.
 */

const ANSWER_MARKER = 'is blocked waiting on your answer';

function orchestratorScript(): (ctx: { input: { prompt: string }; activation: number }) => FakeStep[] {
  return (ctx) => {
    if (ctx.input.prompt.includes(ANSWER_MARKER)) {
      return [{ kind: 'text', text: 'Use Redis for session state, and document the decision.' }];
    }
    if (ctx.input.prompt.includes('Round')) {
      return [
        { kind: 'tool', tool: 'list_tasks', args: {} },
        {
          kind: 'tool',
          tool: 'finish',
          args: { summary: 'Authentication implemented and reviewed.' },
        },
        { kind: 'text', text: 'Synthesised the result.' },
      ];
    }
    return [
      { kind: 'thinking', text: 'Breaking the objective down.' },
      {
        kind: 'tool',
        tool: 'create_tasks',
        args: {
          tasks: [
            {
              key: 'api',
              title: 'Implement the authentication service',
              description: 'Build login and refresh-token rotation.',
              assignee: 'backend',
            },
            {
              key: 'ui',
              title: 'Build the login screen',
              description: 'Wire the UI to the auth API.',
              assignee: 'frontend',
              dependsOn: ['api'],
              reviewer: 'reviewer',
            },
          ],
        },
      },
      { kind: 'text', text: 'Plan created and delegated.' },
    ];
  };
}

async function buildCore(
  behaviors: Record<string, unknown>,
): Promise<{ core: AppCore; provider: FakeAgentProvider }> {
  const provider = new FakeAgentProvider({ behaviors: behaviors as never });
  const core = new AppCore({ storage: new InMemoryStorage(), provider });
  await core.init();
  return { core, provider };
}

describe('run engine (integration)', () => {
  it('orchestrates, delegates across a DAG, and completes the run', async () => {
    const { core, provider } = await buildCore({
      architect: orchestratorScript(),
      backend: () => [
        {
          kind: 'tool',
          tool: 'ask_agent',
          args: {
            to: 'architect',
            question: 'Should refresh tokens live in Redis or Postgres?',
          },
        },
        { kind: 'text', text: 'Auth service implemented; sessions stored in Redis.' },
      ],
      frontend: () => [
        { kind: 'tool', tool: 'send_message', args: { to: ['backend'], content: 'Using your API now.' } },
        { kind: 'text', text: 'Login screen built against the auth API.' },
      ],
      reviewer: () => [{ kind: 'text', text: 'Checked the flow.\nVERDICT: APPROVED' }],
      qa: () => [{ kind: 'text', text: 'No tests requested.' }],
    });

    const team = await core.createTeamFromPreset({
      presetId: 'software-engineering',
      name: 'Engineering',
      workspace: process.cwd(),
    });

    expect(team.agents.map((a) => a.handle)).toEqual([
      'architect',
      'backend',
      'frontend',
      'qa',
      'reviewer',
    ]);

    const run = await core.startRun({
      teamId: team.id,
      objective: 'Implement an authentication system',
    });
    const finished = await core.waitForRun(run.id);

    expect(finished.status).toBe('completed');
    expect(finished.summary).toContain('Authentication implemented');

    const detail = await core.getRunDetail(run.id);

    // The DAG ran: both tasks completed, and the dependent one ran second.
    expect(detail.tasks).toHaveLength(2);
    expect(detail.tasks.every((t) => t.status === 'completed')).toBe(true);
    expect(detail.progress.percent).toBe(100);

    const api = detail.tasks.find((t) => t.title.includes('authentication service'))!;
    const ui = detail.tasks.find((t) => t.title.includes('login screen'))!;
    expect(ui.dependencies).toEqual([api.id]);
    expect(ui.result).toContain('Review by reviewer: approved');

    // Each agent ran with ITS OWN model and effort — never the orchestrator's.
    const architectRun = provider.activationsOf('architect')[0];
    const backendRun = provider.activationsOf('backend')[0];
    const reviewerRun = provider.activationsOf('reviewer')[0];
    expect(architectRun.model).toBe('opus');
    expect(architectRun.effort).toBe('high');
    expect(backendRun.model).toBe('sonnet');
    expect(backendRun.effort).toBe('medium');
    expect(reviewerRun.effort).toBe('high');
    expect(backendRun.model).not.toBe(architectRun.model);

    // Agent-to-agent messaging really happened, in both modes.
    const messages = detail.messages;
    const question = messages.find((m) => m.type === 'question');
    const answer = messages.find((m) => m.type === 'answer');
    expect(question?.content).toContain('Redis or Postgres');
    expect(answer?.content).toContain('Redis');
    expect(answer?.replyTo).toBe(question?.id);
    expect(messages.some((m) => m.type === 'message' && m.content.includes('Using your API'))).toBe(
      true,
    );

    // The timeline recorded model and effort per activation.
    const started = detail.events.filter((e) => e.type === 'agent_started');
    expect(started.length).toBeGreaterThanOrEqual(4);
    expect(started.every((e) => Boolean(e.model) && Boolean(e.effort))).toBe(true);

    expect(detail.events.some((e) => e.type === 'task_created')).toBe(true);
    expect(detail.events.some((e) => e.type === 'task_assigned')).toBe(true);
    expect(detail.events.some((e) => e.type === 'task_completed')).toBe(true);
    expect(detail.events.some((e) => e.type === 'run_completed')).toBe(true);

    // Totals were accumulated.
    expect(finished.totals.agentActivations).toBeGreaterThan(0);
    expect(finished.totals.usage.inputTokens).toBeGreaterThan(0);

    await core.shutdown();
  }, 30_000);

  it('retries a failing task and then fails it permanently', async () => {
    const { core } = await buildCore({
      architect: (ctx: { input: { prompt: string } }) => {
        if (ctx.input.prompt.includes(ANSWER_MARKER)) return [{ kind: 'text', text: 'ok' }];
        if (ctx.input.prompt.includes('Round')) {
          return [{ kind: 'tool', tool: 'finish', args: { summary: 'Could not finish the work.' } }];
        }
        return [
          {
            kind: 'tool',
            tool: 'create_tasks',
            args: {
              tasks: [{ key: 'a', title: 'Do the thing', assignee: 'backend' }],
            },
          },
        ];
      },
      backend: () => [{ kind: 'fail', message: 'compiler exploded' }],
    });

    const team = await core.createTeamFromPreset({ presetId: 'software-engineering' });
    const run = await core.startRun({ teamId: team.id, objective: 'Do the thing' });
    await core.waitForRun(run.id);

    const detail = await core.getRunDetail(run.id);
    const task = detail.tasks[0];
    expect(task.status).toBe('failed');
    expect(task.attempts).toBe(task.maxAttempts);
    expect(task.error).toContain('compiler exploded');
    expect(detail.events.filter((e) => e.type === 'task_failed').length).toBeGreaterThanOrEqual(2);

    await core.shutdown();
  }, 30_000);

  it('stops the run when the cost budget is exhausted', async () => {
    const provider = new FakeAgentProvider({
      costPerActivation: 5,
      behaviors: {
        architect: () => [
          {
            kind: 'tool',
            tool: 'create_tasks',
            args: { tasks: [{ key: 'a', title: 'Work', assignee: 'backend' }] },
          },
        ],
      } as never,
    });
    const core = new AppCore({ storage: new InMemoryStorage(), provider });
    await core.init();

    const team = await core.createTeamFromPreset({ presetId: 'software-engineering' });
    const run = await core.startRun({
      teamId: team.id,
      objective: 'Burn the budget',
      budget: { maxCostUsd: 6 },
    });
    const finished = await core.waitForRun(run.id);

    expect(finished.status).toBe('failed');
    expect(finished.error).toContain('Cost budget');

    const detail = await core.getRunDetail(run.id);
    expect(detail.events.some((e) => e.type === 'budget_exceeded')).toBe(true);

    await core.shutdown();
  }, 30_000);

  it('refuses to finish while the plan it just made has never run', async () => {
    // The orchestrator plans and immediately tries to finish. Tasks are only
    // dispatched after the activation ends, so honouring that would throw the
    // plan away. The engine refuses once, explains, and the work still happens.
    const { core, provider } = await buildCore({
      architect: (ctx: { input: { prompt: string }; activation: number }) => {
        if (ctx.input.prompt.includes('Round')) {
          return [{ kind: 'tool', tool: 'finish', args: { summary: 'All done for real.' } }];
        }
        return [
          {
            kind: 'tool',
            tool: 'create_tasks',
            args: { tasks: [{ key: 'a', title: 'Real work', assignee: 'backend' }] },
          },
          { kind: 'tool', tool: 'finish', args: { summary: 'Planned it, calling that done.' } },
        ];
      },
      backend: () => [{ kind: 'text', text: 'Real work actually done.' }],
    });

    const team = await core.createTeamFromPreset({ presetId: 'software-engineering' });
    const run = await core.startRun({ teamId: team.id, objective: 'Do real work' });
    const finished = await core.waitForRun(run.id);

    const detail = await core.getRunDetail(run.id);
    expect(detail.tasks[0].status).toBe('completed');
    expect(detail.tasks[0].result).toContain('Real work actually done');
    expect(provider.activationsOf('backend')).toHaveLength(1);
    expect(finished.summary).toBe('All done for real.');

    await core.shutdown();
  }, 30_000);

  it('cancels a running run and settles its tasks', async () => {
    const { core } = await buildCore({
      architect: () => [
        {
          kind: 'tool',
          tool: 'create_tasks',
          args: { tasks: [{ key: 'a', title: 'Long job', assignee: 'backend' }] },
        },
      ],
      backend: () => [
        { kind: 'wait', ms: 5_000 },
        { kind: 'text', text: 'never gets here' },
      ],
    });

    const team = await core.createTeamFromPreset({ presetId: 'software-engineering' });
    const run = await core.startRun({ teamId: team.id, objective: 'Something slow' });

    // Wait until the worker is actually running before cancelling.
    await waitUntil(async () => {
      const tasks = await core.listTasks(run.id);
      return tasks.some((t) => t.status === 'running');
    }, 10_000);

    const cancelled = await core.cancelRun(run.id);
    expect(cancelled.status).toBe('cancelled');

    const detail = await core.getRunDetail(run.id);
    expect(detail.tasks.every((t) => ['cancelled', 'failed'].includes(t.status))).toBe(true);
    expect(detail.events.some((e) => e.type === 'run_cancelled')).toBe(true);

    await core.shutdown();
  }, 30_000);
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Condition was never met');
}
