import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '@claude-team/persistence';
import { FakeAgentProvider, type FakeStep } from '@claude-team/provider';
import { AppCore } from '../src/app-core.js';

/**
 * Agent-to-agent communication through the real bus. The domain tests prove the
 * routing *rules*; these prove the runtime actually enforces them, that a
 * refusal comes back to the agent as usable text, and that nothing hangs.
 */

const ANSWER = 'is blocked waiting on your answer';

function build(behaviors: Record<string, unknown>, settings?: Record<string, unknown>) {
  const provider = new FakeAgentProvider({ behaviors: behaviors as never });
  const app = new AppCore({ storage: new InMemoryStorage(), provider });
  return { app, provider, settings };
}

describe('agent-to-agent messaging', () => {
  it('does not deadlock when two agents ask each other in a cycle', async () => {
    const { app } = build({
      architect: (ctx: { input: { prompt: string } }) => {
        if (ctx.input.prompt.includes(ANSWER)) {
          // Architect, while answering backend, tries to ask backend back.
          // That would deadlock, so the bus must refuse it.
          return [
            { kind: 'tool', tool: 'ask_agent', args: { to: 'backend', question: 'What do you think?' } },
            { kind: 'text', text: 'Decided without asking: use Redis.' },
          ] satisfies FakeStep[];
        }
        if (ctx.input.prompt.includes('Round')) {
          return [{ kind: 'tool', tool: 'finish', args: { summary: 'Done.' } }];
        }
        return [
          {
            kind: 'tool',
            tool: 'create_tasks',
            args: { tasks: [{ key: 'a', title: 'Build it', assignee: 'backend' }] },
          },
        ];
      },
      backend: () => [
        { kind: 'tool', tool: 'ask_agent', args: { to: 'architect', question: 'Redis or Postgres?' } },
        { kind: 'text', text: 'Built it with Redis.' },
      ],
    });
    await app.init();

    const team = await app.createTeamFromPreset({ presetId: 'software-engineering' });
    const run = await app.startRun({ teamId: team.id, objective: 'Ship it' });

    // The whole point: this resolves instead of hanging.
    const finished = await app.waitForRun(run.id);
    expect(finished.status).toBe('completed');

    const detail = await app.getRunDetail(run.id);
    expect(detail.tasks[0].status).toBe('completed');
    expect(detail.tasks[0].result).toContain('Redis');

    // The reverse ask was refused and the refusal was recorded.
    expect(
      detail.events.some(
        (e) => e.level === 'warn' && /not delivered|already waiting/i.test(e.summary),
      ),
    ).toBe(true);

    await app.shutdown();
  }, 30_000);

  it('tells an agent, in words, why a message was not delivered', async () => {
    const { app } = build({
      // The reviewer template may only message the lead in this preset.
      lead: (ctx: { input: { prompt: string } }) => {
        if (ctx.input.prompt.includes('Round')) {
          return [{ kind: 'tool', tool: 'finish', args: { summary: 'Audit done.' } }];
        }
        return [
          {
            kind: 'tool',
            tool: 'create_tasks',
            args: { tasks: [{ key: 'a', title: 'Review', assignee: 'reviewer' }] },
          },
        ];
      },
      reviewer: () => [
        { kind: 'tool', tool: 'send_message', args: { to: ['security'], content: 'Take a look?' } },
        { kind: 'text', text: 'Reviewed.' },
      ],
    });
    await app.init();

    const team = await app.createTeamFromPreset({ presetId: 'review-board' });
    const run = await app.startRun({ teamId: team.id, objective: 'Audit the codebase' });
    await app.waitForRun(run.id);

    const detail = await app.getRunDetail(run.id);
    // No message was persisted to security...
    const security = detail.agents.find((a) => a.handle === 'security')!;
    expect(detail.messages.some((m) => m.to.includes(security.id))).toBe(false);
    // ...and the refusal is on the timeline.
    expect(
      detail.events.some((e) => e.summary.includes('not delivered') && e.summary.includes('reviewer')),
    ).toBe(true);

    await app.shutdown();
  }, 30_000);

  it('lets the human inject a message into a live run and read the inbox', async () => {
    const { app } = build({
      assistant: () => [
        { kind: 'tool', tool: 'check_inbox', args: {} },
        { kind: 'tool', tool: 'finish', args: { summary: 'Read my mail.' } },
      ],
    });
    await app.init();

    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const agent = team.agents[0];
    const run = await app.startRun({ teamId: team.id, objective: 'Wait for input', autoStart: false });

    const message = await app.sendAgentMessage({
      runId: run.id,
      from: 'user',
      to: [agent.handle],
      content: 'Prioritise the auth work.',
      type: 'request',
    });

    expect(message.from).toBe('user');
    expect(message.to).toEqual([agent.id]);

    const inbox = await app.agentInbox(run.id, agent.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].status).toBe('pending');
    expect(inbox[0].content).toBe('Prioritise the auth work.');

    await app.runs.start(run.id);
    await app.waitForRun(run.id);

    // Once the agent ran, the message was consumed.
    const after = await app.agentInbox(run.id, agent.id);
    expect(after[0].status).not.toBe('pending');

    await app.shutdown();
  }, 30_000);

  it('honours a per-agent inbox limit', async () => {
    const { app } = build({
      architect: (ctx: { input: { prompt: string } }) => {
        if (ctx.input.prompt.includes('Round')) {
          return [{ kind: 'tool', tool: 'finish', args: { summary: 'Enough.' } }];
        }
        return [
          { kind: 'tool', tool: 'send_message', args: { to: ['backend'], content: 'one' } },
          { kind: 'tool', tool: 'send_message', args: { to: ['backend'], content: 'two' } },
          { kind: 'tool', tool: 'send_message', args: { to: ['backend'], content: 'three' } },
        ];
      },
    });
    await app.init();

    const team = await app.createTeamFromPreset({ presetId: 'software-engineering' });
    const backend = team.agents.find((a) => a.handle === 'backend')!;
    await app.updateAgent(backend.id, { limits: { maxMessages: 2 } });

    const run = await app.startRun({ teamId: team.id, objective: 'Talk a lot' });
    await app.waitForRun(run.id);

    const detail = await app.getRunDetail(run.id);
    const delivered = detail.messages.filter((m) => m.to.includes(backend.id));
    expect(delivered).toHaveLength(2);
    expect(
      detail.events.some((e) => e.summary.includes('inbox limit') || e.summary.includes('not delivered')),
    ).toBe(true);

    await app.shutdown();
  }, 30_000);
});
