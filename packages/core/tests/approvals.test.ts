import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '@claude-team/persistence';
import { FakeAgentProvider, type FakeStep } from '@claude-team/provider';
import { AppCore } from '../src/app-core.js';
import type { AppEvent } from '../src/event-bus.js';

/**
 * Human-in-the-loop. The fake provider's `guarded` step goes through the very
 * same permission callback the Claude provider uses, so these tests exercise
 * the real approval gate rather than a stand-in.
 */

function coreWith(steps: Record<string, FakeStep[]>, engineOptions?: Record<string, unknown>) {
  const provider = new FakeAgentProvider({ behaviors: steps as never });
  const app = new AppCore({
    storage: new InMemoryStorage(),
    provider,
    engineOptions: { approvalTimeoutMs: 3_000, ...(engineOptions ?? {}) } as never,
  });
  return { app, provider };
}

const RM_STEP: FakeStep = {
  kind: 'guarded',
  tool: 'Bash',
  input: { command: 'rm -rf ./generated' },
  group: 'terminal',
};

async function waitForApproval(app: AppCore, events: AppEvent[]): Promise<string> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const pending = events
      .filter((e): e is Extract<AppEvent, { type: 'approval' }> => e.type === 'approval')
      .find((e) => e.approval.status === 'pending');
    if (pending) return pending.approval.id;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('No approval was ever requested');
}

describe('human-in-the-loop approvals', () => {
  it('parks the agent until a human decides, and records the decision', async () => {
    const { app } = coreWith({
      assistant: [RM_STEP, { kind: 'tool', tool: 'finish', args: { summary: 'Cleaned up.' } }],
    });
    await app.init();

    const events: AppEvent[] = [];
    app.subscribe((e) => events.push(e));

    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const run = await app.startRun({ teamId: team.id, objective: 'Clean the build output' });

    const approvalId = await waitForApproval(app, events);

    // The request describes exactly what will happen, and is categorised.
    const stored = (await app.storage.approvals.list({ runId: run.id }))[0];
    expect(stored.summary).toContain('rm -rf ./generated');
    expect(stored.category).toBe('destructive');
    expect(stored.status).toBe('pending');

    await app.resolveApproval({ approvalId, decision: 'allow_once' });
    const finished = await app.waitForRun(run.id);
    expect(finished.status).toBe('completed');

    const resolved = (await app.storage.approvals.list({ runId: run.id }))[0];
    expect(resolved.status).toBe('resolved');
    expect(resolved.decision).toBe('allow_once');

    const detail = await app.getRunDetail(run.id);
    expect(detail.events.some((e) => e.type === 'approval_requested')).toBe(true);
    expect(detail.events.some((e) => e.type === 'approval_resolved')).toBe(true);
    await app.shutdown();
  }, 20_000);

  it('denies the tool call when the human says no, without killing the run', async () => {
    const { app } = coreWith({
      assistant: [
        RM_STEP,
        { kind: 'text', text: 'I was not allowed to delete anything.' },
        { kind: 'tool', tool: 'finish', args: { summary: 'Stopped: permission denied.' } },
      ],
    });
    await app.init();

    const events: AppEvent[] = [];
    app.subscribe((e) => events.push(e));

    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const run = await app.startRun({ teamId: team.id, objective: 'Clean the build output' });

    const approvalId = await waitForApproval(app, events);
    await app.resolveApproval({ approvalId, decision: 'deny' });

    const finished = await app.waitForRun(run.id);
    expect(finished.status).toBe('completed');
    expect(finished.summary).toContain('permission denied');

    const detail = await app.getRunDetail(run.id);
    expect(
      detail.events.some((e) => e.level === 'warn' && e.summary.includes('denied')),
    ).toBe(true);
    await app.shutdown();
  }, 20_000);

  it('remembers "always for this run" for the same category', async () => {
    const { app } = coreWith({
      assistant: [
        RM_STEP,
        { kind: 'guarded', tool: 'Bash', input: { command: 'rm -rf ./dist' }, group: 'terminal' },
        { kind: 'tool', tool: 'finish', args: { summary: 'Both cleanups done.' } },
      ],
    });
    await app.init();

    const events: AppEvent[] = [];
    app.subscribe((e) => events.push(e));

    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const run = await app.startRun({ teamId: team.id, objective: 'Clean everything' });

    const approvalId = await waitForApproval(app, events);
    await app.resolveApproval({ approvalId, decision: 'allow_always' });

    const finished = await app.waitForRun(run.id);
    expect(finished.status).toBe('completed');

    // Only the first call asked; the second was covered by the blanket grant.
    const approvals = await app.storage.approvals.list({ runId: run.id });
    expect(approvals).toHaveLength(1);
    await app.shutdown();
  }, 20_000);

  it('skips every prompt when the operator opted into auto-approval', async () => {
    const { app } = coreWith({
      assistant: [RM_STEP, { kind: 'tool', tool: 'finish', args: { summary: 'Done.' } }],
    });
    await app.init();
    await app.updateSettings({ autoApproveAll: true });

    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const run = await app.startRun({ teamId: team.id, objective: 'Clean the build output' });
    const finished = await app.waitForRun(run.id);

    expect(finished.status).toBe('completed');
    expect(await app.storage.approvals.list({ runId: run.id })).toHaveLength(0);
    await app.shutdown();
  }, 20_000);

  it('denies a request nobody answered before the timeout', async () => {
    const { app } = coreWith(
      {
        assistant: [RM_STEP, { kind: 'tool', tool: 'finish', args: { summary: 'Gave up.' } }],
      },
      { approvalTimeoutMs: 300 },
    );
    await app.init();

    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const run = await app.startRun({ teamId: team.id, objective: 'Clean the build output' });
    const finished = await app.waitForRun(run.id);

    expect(finished.status).toBe('completed');
    const approvals = await app.storage.approvals.list({ runId: run.id });
    expect(approvals[0].decision).toBe('deny');
    expect(approvals[0].decidedBy).toBe('timeout');
    await app.shutdown();
  }, 20_000);
});

describe('capability enforcement', () => {
  it('passes each agent’s own capability grants to the provider', async () => {
    const { app, provider } = coreWith({});
    await app.init();

    const team = await app.createTeamFromPreset({ presetId: 'software-engineering' });
    const reviewer = team.agents.find((a) => a.handle === 'reviewer')!;
    // The reviewer template is read-only by design.
    expect(reviewer.tools.find((t) => t.group === 'filesystem_write')?.mode).toBe('deny');

    const backend = team.agents.find((a) => a.handle === 'backend')!;
    expect(backend.tools.find((t) => t.group === 'filesystem_write')?.mode).toBe('allow');

    const run = await app.startRun({ teamId: team.id, objective: 'Anything' });
    await app.waitForRun(run.id);

    const architectActivation = provider.activationsOf('architect')[0];
    expect(architectActivation.customToolNames).toContain('create_tasks');
    expect(architectActivation.customToolNames).toContain('finish');
    await app.shutdown();
  }, 20_000);

  it('withholds orchestration tools from agents that are not the orchestrator', async () => {
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
    const run = await app.startRun({ teamId: team.id, objective: 'Delegate something' });
    await app.waitForRun(run.id);

    const backendActivation = provider.activationsOf('backend')[0];
    expect(backendActivation.customToolNames).not.toContain('create_tasks');
    expect(backendActivation.customToolNames).not.toContain('finish');
    // But it can still talk to its team.
    expect(backendActivation.customToolNames).toContain('send_message');
    expect(backendActivation.customToolNames).toContain('ask_agent');
    await app.shutdown();
  }, 20_000);
});
