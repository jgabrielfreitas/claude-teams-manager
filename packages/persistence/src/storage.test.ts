import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import SqliteDatabase from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultSettings,
  emptyUsage,
  ids,
  type Agent,
  type AgentMessage,
  type ApprovalRequest,
  type Run,
  type RunEvent,
  type Task,
  type Team,
} from '@claude-team/domain';

import { InMemoryStorage } from './memory-storage.js';
import { applyMigrations, migrations, type Database } from './migrations.js';
import { SqliteStorage } from './sqlite-storage.js';
import type { Storage } from './storage.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const T0 = new Date('2026-01-01T00:00:00.000Z');

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

function makeTeam(over: Partial<Team> = {}): Team {
  return {
    id: ids.team(),
    name: `team-${Math.random().toString(36).slice(2, 8)}`,
    metadata: {},
    createdAt: at(0),
    updatedAt: at(0),
    ...over,
  };
}

function makeAgent(teamId: string, over: Partial<Agent> = {}): Agent {
  return {
    id: ids.agent(),
    teamId,
    handle: `agent-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Ada',
    role: 'engineer',
    systemPrompt: 'You are Ada.',
    model: 'sonnet',
    effort: 'medium',
    tools: [{ group: 'filesystem_read', mode: 'allow' }],
    context: '',
    memory: { enabled: true, notes: '' },
    communicationRules: '',
    canMessage: ['*'],
    limits: {},
    status: 'idle',
    order: 0,
    metadata: {},
    createdAt: at(0),
    updatedAt: at(0),
    ...over,
  };
}

function makeRun(teamId: string, over: Partial<Run> = {}): Run {
  return {
    id: ids.run(),
    teamId,
    objective: 'ship it',
    status: 'queued',
    agentConfigSnapshot: [],
    totals: { usage: emptyUsage(), costUsd: 0, agentActivations: 0, toolCalls: 0, messages: 0 },
    createdAt: at(0),
    updatedAt: at(0),
    ...over,
  };
}

function makeTask(runId: string, over: Partial<Task> = {}): Task {
  return {
    id: ids.task(),
    runId,
    title: 'do the thing',
    description: '',
    status: 'ready',
    dependencies: [],
    createdBy: 'user',
    attempts: 0,
    maxAttempts: 2,
    order: 0,
    createdAt: at(0),
    updatedAt: at(0),
    ...over,
  };
}

function makeMessage(runId: string, seq: number, over: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: ids.message(),
    seq,
    runId,
    from: 'user',
    to: ['ada'],
    type: 'message',
    content: `hello ${seq}`,
    status: 'pending',
    hop: 0,
    path: ['user'],
    createdAt: at(seq),
    ...over,
  };
}

function makeEvent(runId: string, seq: number, over: Partial<RunEvent> = {}): RunEvent {
  return {
    id: ids.event(),
    seq,
    runId,
    type: 'log',
    summary: `event ${seq}`,
    data: {},
    level: 'info',
    createdAt: at(seq),
    ...over,
  };
}

function makeApproval(runId: string, over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: ids.approval(),
    runId,
    agentId: 'ag_1',
    category: 'shell',
    toolName: 'bash',
    summary: 'rm -rf nothing',
    input: { command: 'ls' },
    status: 'pending',
    createdAt: at(0),
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * Conformance suite, run against every implementation
 * ------------------------------------------------------------------ */

const implementations: Array<[string, () => Storage]> = [
  ['sqlite', () => new SqliteStorage({ location: ':memory:' })],
  ['memory', () => new InMemoryStorage()],
];

describe.each(implementations)('%s storage', (_driver, create) => {
  let storage: Storage;

  beforeEach(async () => {
    storage = create();
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
  });

  /** Team + run scaffolding most tests need. */
  async function seed(): Promise<{ team: Team; run: Run }> {
    const team = await storage.teams.create(makeTeam());
    const run = await storage.runs.create(makeRun(team.id));
    return { team, run };
  }

  it('describes itself', () => {
    const described = storage.describe();
    expect(typeof described.driver).toBe('string');
    expect(described.driver.length).toBeGreaterThan(0);
    expect(typeof described.location).toBe('string');
  });

  it('init is safe to call more than once', async () => {
    await storage.init();
    await storage.init();
    expect(await storage.teams.list()).toEqual([]);
  });

  /* --------------------------- teams --------------------------- */

  describe('teams', () => {
    it('creates, reads, updates and deletes', async () => {
      const team = makeTeam({ name: 'alpha', description: 'first' });
      const created = await storage.teams.create(team);
      expect(created).toEqual(team);

      expect(await storage.teams.get(team.id)).toEqual(team);
      expect(await storage.teams.findByName('alpha')).toEqual(team);
      expect(await storage.teams.findByName('nope')).toBeUndefined();
      expect(await storage.teams.list()).toEqual([team]);

      const updated: Team = {
        ...team,
        name: 'beta',
        description: undefined,
        workspace: '/tmp/beta',
        updatedAt: at(1000),
      };
      const returned = await storage.teams.update(updated);
      expect(returned).toEqual(updated);
      expect(await storage.teams.get(team.id)).toEqual(updated);
      expect((await storage.teams.get(team.id))?.description).toBeUndefined();

      await storage.teams.delete(team.id);
      expect(await storage.teams.get(team.id)).toBeUndefined();
      expect(await storage.teams.list()).toEqual([]);
    });

    it('rejects updating a team that does not exist', async () => {
      await expect(storage.teams.update(makeTeam())).rejects.toThrow();
    });

    it('does not let callers mutate stored state through returned objects', async () => {
      const team = await storage.teams.create(makeTeam({ name: 'gamma' }));
      team.name = 'mutated';
      (team.metadata as Record<string, unknown>)['x'] = 1;
      const fetched = await storage.teams.get(team.id);
      expect(fetched?.name).toBe('gamma');
      expect(fetched?.metadata).toEqual({});
    });
  });

  /* --------------------------- agents -------------------------- */

  describe('agents', () => {
    it('creates, reads, updates and deletes', async () => {
      const team = await storage.teams.create(makeTeam());
      const agent = makeAgent(team.id, { handle: 'architect', order: 0 });
      const created = await storage.agents.create(agent);
      expect(created).toEqual(agent);

      expect(await storage.agents.get(agent.id)).toEqual(agent);
      expect(await storage.agents.getByHandle(team.id, 'architect')).toEqual(agent);
      expect(await storage.agents.getByHandle(team.id, 'ghost')).toBeUndefined();
      expect(await storage.agents.listByTeam(team.id)).toEqual([agent]);
      expect(await storage.agents.listAll()).toEqual([agent]);

      const updated: Agent = { ...agent, name: 'Grace', status: 'working', updatedAt: at(50) };
      expect(await storage.agents.update(updated)).toEqual(updated);
      expect(await storage.agents.get(agent.id)).toEqual(updated);

      await storage.agents.delete(agent.id);
      expect(await storage.agents.get(agent.id)).toBeUndefined();
      expect(await storage.agents.listByTeam(team.id)).toEqual([]);
    });

    it('orders a team by display order', async () => {
      const team = await storage.teams.create(makeTeam());
      await storage.agents.create(makeAgent(team.id, { handle: 'c', order: 2 }));
      await storage.agents.create(makeAgent(team.id, { handle: 'a', order: 0 }));
      await storage.agents.create(makeAgent(team.id, { handle: 'b', order: 1 }));

      const handles = (await storage.agents.listByTeam(team.id)).map((a) => a.handle);
      expect(handles).toEqual(['a', 'b', 'c']);
    });

    it('enforces a unique handle per team', async () => {
      const team = await storage.teams.create(makeTeam());
      const other = await storage.teams.create(makeTeam());

      await storage.agents.create(makeAgent(team.id, { handle: 'architect' }));
      await expect(
        storage.agents.create(makeAgent(team.id, { handle: 'architect' })),
      ).rejects.toThrow();

      // The same handle is fine in a different team.
      await expect(
        storage.agents.create(makeAgent(other.id, { handle: 'architect' })),
      ).resolves.toBeDefined();
    });

    it('resets every status to idle', async () => {
      const team = await storage.teams.create(makeTeam());
      await storage.agents.create(makeAgent(team.id, { handle: 'a', status: 'working' }));
      await storage.agents.create(makeAgent(team.id, { handle: 'b', status: 'failed' }));
      await storage.agents.create(makeAgent(team.id, { handle: 'c', status: 'idle' }));

      await storage.agents.resetStatuses();

      const statuses = (await storage.agents.listAll()).map((a) => a.status);
      expect(statuses).toEqual(['idle', 'idle', 'idle']);
    });
  });

  /* ---------------------------- runs --------------------------- */

  describe('runs', () => {
    it('creates, reads, updates and deletes', async () => {
      const team = await storage.teams.create(makeTeam());
      const run = makeRun(team.id);
      expect(await storage.runs.create(run)).toEqual(run);
      expect(await storage.runs.get(run.id)).toEqual(run);

      const updated: Run = {
        ...run,
        status: 'completed',
        summary: 'all good',
        startedAt: at(10),
        completedAt: at(20),
        updatedAt: at(20),
        totals: {
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            cacheCreationInputTokens: 3,
            cacheReadInputTokens: 4,
          },
          costUsd: 1.25,
          agentActivations: 2,
          toolCalls: 7,
          messages: 5,
        },
      };
      expect(await storage.runs.update(updated)).toEqual(updated);
      expect(await storage.runs.get(run.id)).toEqual(updated);

      await storage.runs.delete(run.id);
      expect(await storage.runs.get(run.id)).toBeUndefined();
    });

    it('filters by team and status, newest first', async () => {
      const teamA = await storage.teams.create(makeTeam());
      const teamB = await storage.teams.create(makeTeam());

      const r1 = await storage.runs.create(
        makeRun(teamA.id, { status: 'completed', createdAt: at(1) }),
      );
      const r2 = await storage.runs.create(
        makeRun(teamA.id, { status: 'running', createdAt: at(2) }),
      );
      const r3 = await storage.runs.create(
        makeRun(teamB.id, { status: 'running', createdAt: at(3) }),
      );

      expect((await storage.runs.list()).map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);
      expect((await storage.runs.list({ teamId: teamA.id })).map((r) => r.id)).toEqual([
        r2.id,
        r1.id,
      ]);
      expect((await storage.runs.list({ status: ['running'] })).map((r) => r.id)).toEqual([
        r3.id,
        r2.id,
      ]);
      expect(
        (await storage.runs.list({ teamId: teamA.id, status: ['completed'] })).map((r) => r.id),
      ).toEqual([r1.id]);
      expect((await storage.runs.list({ limit: 2 })).map((r) => r.id)).toEqual([r3.id, r2.id]);
      expect((await storage.runs.list({ limit: 2, offset: 1 })).map((r) => r.id)).toEqual([
        r2.id,
        r1.id,
      ]);
      expect(await storage.runs.list({ status: ['cancelled'] })).toEqual([]);
    });

    it('lists interrupted runs (queued, running, paused)', async () => {
      const team = await storage.teams.create(makeTeam());
      const queued = await storage.runs.create(makeRun(team.id, { status: 'queued', createdAt: at(1) }));
      const running = await storage.runs.create(
        makeRun(team.id, { status: 'running', createdAt: at(2) }),
      );
      const paused = await storage.runs.create(makeRun(team.id, { status: 'paused', createdAt: at(3) }));
      await storage.runs.create(makeRun(team.id, { status: 'completed', createdAt: at(4) }));
      await storage.runs.create(makeRun(team.id, { status: 'failed', createdAt: at(5) }));
      await storage.runs.create(makeRun(team.id, { status: 'cancelled', createdAt: at(6) }));

      const interrupted = await storage.runs.listInterrupted();
      expect(interrupted.map((r) => r.id).sort()).toEqual([queued.id, running.id, paused.id].sort());
    });
  });

  /* --------------------------- tasks --------------------------- */

  describe('tasks', () => {
    it('creates, reads, updates and deletes', async () => {
      const { run } = await seed();
      const task = makeTask(run.id, { title: 'first' });
      expect(await storage.tasks.create(task)).toEqual(task);
      expect(await storage.tasks.get(task.id)).toEqual(task);
      expect(await storage.tasks.listByRun(run.id)).toEqual([task]);

      const updated: Task = {
        ...task,
        status: 'completed',
        result: 'done',
        attempts: 1,
        startedAt: at(5),
        completedAt: at(9),
        updatedAt: at(9),
      };
      expect(await storage.tasks.update(updated)).toEqual(updated);
      expect(await storage.tasks.get(task.id)).toEqual(updated);

      await storage.tasks.delete(task.id);
      expect(await storage.tasks.get(task.id)).toBeUndefined();
      expect(await storage.tasks.listByRun(run.id)).toEqual([]);
    });

    it('creates and updates in bulk, ordered by display order', async () => {
      const { run } = await seed();
      const a = makeTask(run.id, { title: 'a', order: 0 });
      const b = makeTask(run.id, { title: 'b', order: 1, dependencies: [a.id] });
      const c = makeTask(run.id, { title: 'c', order: 2 });

      const created = await storage.tasks.createMany([c, a, b]);
      expect(created.map((t) => t.title)).toEqual(['c', 'a', 'b']);
      expect((await storage.tasks.listByRun(run.id)).map((t) => t.title)).toEqual(['a', 'b', 'c']);
      expect((await storage.tasks.get(b.id))?.dependencies).toEqual([a.id]);

      await storage.tasks.updateMany([
        { ...a, status: 'completed' },
        { ...b, status: 'running' },
      ]);
      expect((await storage.tasks.get(a.id))?.status).toBe('completed');
      expect((await storage.tasks.get(b.id))?.status).toBe('running');
      expect((await storage.tasks.get(c.id))?.status).toBe('ready');
    });
  });

  /* -------------------------- messages ------------------------- */

  describe('messages', () => {
    it('creates, reads and updates', async () => {
      const { run } = await seed();
      const message = makeMessage(run.id, 1);
      expect(await storage.messages.create(message)).toEqual(message);
      expect(await storage.messages.get(message.id)).toEqual(message);
      expect(await storage.messages.countByRun(run.id)).toBe(1);

      const updated: AgentMessage = {
        ...message,
        status: 'completed',
        readAt: at(100),
        completedAt: at(200),
      };
      expect(await storage.messages.update(updated)).toEqual(updated);
      expect(await storage.messages.get(message.id)).toEqual(updated);
    });

    it('filters by run, participants and sequence', async () => {
      const { run } = await seed();
      const other = await storage.runs.create(makeRun((await storage.teams.list())[0]!.id));

      const m1 = await storage.messages.create(
        makeMessage(run.id, 1, { from: 'user', to: ['ada', 'grace'] }),
      );
      const m2 = await storage.messages.create(
        makeMessage(run.id, 2, { from: 'ada', to: ['user'] }),
      );
      const m3 = await storage.messages.create(
        makeMessage(run.id, 3, { from: 'grace', to: ['ada'] }),
      );
      await storage.messages.create(makeMessage(other.id, 1, { from: 'user', to: ['ada'] }));

      expect((await storage.messages.list({ runId: run.id })).map((m) => m.id)).toEqual([
        m1.id,
        m2.id,
        m3.id,
      ]);
      expect(
        (await storage.messages.list({ runId: run.id, toParticipant: 'ada' })).map((m) => m.id),
      ).toEqual([m1.id, m3.id]);
      expect(
        (await storage.messages.list({ runId: run.id, toParticipant: 'grace' })).map((m) => m.id),
      ).toEqual([m1.id]);
      expect(
        (await storage.messages.list({ runId: run.id, fromParticipant: 'ada' })).map((m) => m.id),
      ).toEqual([m2.id]);
      expect(
        (await storage.messages.list({ runId: run.id, afterSeq: 1 })).map((m) => m.id),
      ).toEqual([m2.id, m3.id]);
      expect(
        (await storage.messages.list({ runId: run.id, afterSeq: 3 })).map((m) => m.id),
      ).toEqual([]);
      expect(
        (await storage.messages.list({ runId: run.id, limit: 2 })).map((m) => m.id),
      ).toEqual([m1.id, m2.id]);
      expect(
        (await storage.messages.list({ runId: run.id, limit: 1, offset: 1 })).map((m) => m.id),
      ).toEqual([m2.id]);

      expect(await storage.messages.countByRun(run.id)).toBe(3);
      expect(await storage.messages.countByRun(other.id)).toBe(1);
    });

    it('allocates 200 sequential sequence numbers with no gaps or duplicates', async () => {
      const { run } = await seed();
      const seen: number[] = [];
      for (let i = 0; i < 200; i++) seen.push(await storage.messages.nextSeq(run.id));

      expect(seen).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
      expect(new Set(seen).size).toBe(200);
    });

    it('allocates unique sequence numbers under concurrent calls', async () => {
      const { run } = await seed();
      const seen = await Promise.all(
        Array.from({ length: 200 }, () => storage.messages.nextSeq(run.id)),
      );
      expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    });

    it('keeps sequences independent per run and per kind', async () => {
      const { team, run } = await seed();
      const runB = await storage.runs.create(makeRun(team.id));

      expect(await storage.messages.nextSeq(run.id)).toBe(1);
      expect(await storage.messages.nextSeq(run.id)).toBe(2);
      expect(await storage.messages.nextSeq(runB.id)).toBe(1);
      expect(await storage.events.nextSeq(run.id)).toBe(1);
      expect(await storage.events.nextSeq(run.id)).toBe(2);
      expect(await storage.messages.nextSeq(run.id)).toBe(3);
    });
  });

  /* --------------------------- events -------------------------- */

  describe('events', () => {
    it('appends and lists with filters', async () => {
      const { run } = await seed();
      const e1 = await storage.events.append(
        makeEvent(run.id, 1, { type: 'run_created', agentId: 'ag_1' }),
      );
      const e2 = await storage.events.append(
        makeEvent(run.id, 2, { type: 'tool_call', agentId: 'ag_2' }),
      );
      const e3 = await storage.events.append(
        makeEvent(run.id, 3, { type: 'tool_call', agentId: 'ag_1' }),
      );

      expect((await storage.events.list({ runId: run.id })).map((e) => e.id)).toEqual([
        e1.id,
        e2.id,
        e3.id,
      ]);
      expect((await storage.events.list({ runId: run.id, afterSeq: 1 })).map((e) => e.id)).toEqual([
        e2.id,
        e3.id,
      ]);
      expect(
        (await storage.events.list({ runId: run.id, types: ['tool_call'] })).map((e) => e.id),
      ).toEqual([e2.id, e3.id]);
      expect(
        (await storage.events.list({ runId: run.id, agentId: 'ag_1' })).map((e) => e.id),
      ).toEqual([e1.id, e3.id]);
      expect(
        (await storage.events.list({ runId: run.id, afterSeq: 1, types: ['tool_call'], agentId: 'ag_1' })).map(
          (e) => e.id,
        ),
      ).toEqual([e3.id]);
      expect(await storage.events.countByRun(run.id)).toBe(3);
    });

    it('returns the newest events across all runs', async () => {
      const { team, run } = await seed();
      const runB = await storage.runs.create(makeRun(team.id));

      await storage.events.append(makeEvent(run.id, 1, { createdAt: at(10) }));
      const b = await storage.events.append(makeEvent(runB.id, 1, { createdAt: at(20) }));
      const c = await storage.events.append(makeEvent(run.id, 2, { createdAt: at(30) }));

      const recent = await storage.events.recent(2);
      expect(recent.map((e) => e.id)).toEqual([c.id, b.id]);
      expect((await storage.events.recent(10)).length).toBe(3);
    });

    it('round-trips numeric and JSON payloads', async () => {
      const { run } = await seed();
      const event = makeEvent(run.id, 1, {
        data: { nested: { a: [1, 2, 3] }, flag: true },
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 4,
        },
        costUsd: 0.0125,
        durationMs: 1234,
        model: 'opus',
        effort: 'high',
        level: 'warn',
      });
      await storage.events.append(event);
      const [stored] = await storage.events.list({ runId: run.id });
      expect(stored).toEqual(event);
    });
  });

  /* -------------------------- approvals ------------------------ */

  describe('approvals', () => {
    it('creates, reads, updates and filters', async () => {
      const { team, run } = await seed();
      const runB = await storage.runs.create(makeRun(team.id));

      const a1 = await storage.approvals.create(makeApproval(run.id, { createdAt: at(1) }));
      const a2 = await storage.approvals.create(
        makeApproval(run.id, { status: 'resolved', decision: 'allow_once', createdAt: at(2) }),
      );
      const a3 = await storage.approvals.create(makeApproval(runB.id, { createdAt: at(3) }));

      expect(await storage.approvals.get(a1.id)).toEqual(a1);
      expect((await storage.approvals.list()).map((a) => a.id)).toEqual([a1.id, a2.id, a3.id]);
      expect((await storage.approvals.list({ runId: run.id })).map((a) => a.id)).toEqual([
        a1.id,
        a2.id,
      ]);
      expect((await storage.approvals.list({ status: 'pending' })).map((a) => a.id)).toEqual([
        a1.id,
        a3.id,
      ]);

      const resolved: ApprovalRequest = {
        ...a1,
        status: 'resolved',
        decision: 'deny',
        decidedBy: 'user',
        resolvedAt: at(500),
      };
      expect(await storage.approvals.update(resolved)).toEqual(resolved);
      expect(await storage.approvals.get(a1.id)).toEqual(resolved);
    });
  });

  /* -------------------------- settings ------------------------- */

  describe('settings', () => {
    it('returns the defaults and persists them', async () => {
      const defaults = defaultSettings();
      const first = await storage.settings.get();

      expect(first.defaultModel).toBe(defaults.defaultModel);
      expect(first.defaultOrchestratorModel).toBe(defaults.defaultOrchestratorModel);
      expect(first.defaultEffort).toBe(defaults.defaultEffort);
      expect(first.provider).toBe(defaults.provider);
      expect(first.defaultBudget).toEqual(defaults.defaultBudget);
      expect(first.requireApprovalFor).toEqual(defaults.requireApprovalFor);
      expect(first.onboardingCompleted).toBe(false);
      expect(first.autoApproveAll).toBe(false);
      expect(first.telemetry).toBe(false);
      expect(first.theme).toBe(defaults.theme);
      expect(first.webPort).toBe(defaults.webPort);
      expect(first.maxHops).toBe(defaults.maxHops);
      expect(first.maxRecursionDepth).toBe(defaults.maxRecursionDepth);
      expect(first.askTimeoutMs).toBe(defaults.askTimeoutMs);
      expect(first.defaultWorkspace).toBeUndefined();
      // Nothing of the machine's own Claude Code setup is inherited until it is
      // switched on: an upgrade must not silently change how agents behave.
      expect(first.localSetup).toEqual({ settingSources: [], skills: 'none', mcpServers: false });
      expect(first.updatedAt).toBeInstanceOf(Date);

      // Persisted: a second read returns the very same row, not a fresh default.
      const second = await storage.settings.get();
      expect(second).toEqual(first);
    });

    it('saves and reads back', async () => {
      const next = {
        ...defaultSettings(at(0)),
        onboardingCompleted: true,
        defaultWorkspace: '/work',
        defaultModel: 'opus',
        theme: 'dark' as const,
        telemetry: true,
        autoApproveAll: true,
        webPort: 9999,
        requireApprovalFor: ['shell'],
        defaultBudget: { maxTokens: 1, maxCostUsd: 2 },
        localSetup: {
          settingSources: ['user' as const, 'project' as const],
          skills: ['research', 'laudo-de-bug'],
          mcpServers: true,
          executablePath: '/usr/local/bin/claude',
        },
        updatedAt: at(1234),
      };
      expect(await storage.settings.save(next)).toEqual(next);
      expect(await storage.settings.get()).toEqual(next);

      const cleared = { ...next, defaultWorkspace: undefined, updatedAt: at(2345) };
      await storage.settings.save(cleared);
      const read = await storage.settings.get();
      expect(read.defaultWorkspace).toBeUndefined();
      expect(read).toEqual(cleared);
    });

    it('normalises a local setup that came from outside, identically in both drivers', async () => {
      const saved = await storage.settings.save({
        ...defaultSettings(at(0)),
        localSetup: {
          // Duplicates, an unknown source and a blank executable are all things a
          // hand-edited file or an older row can contain.
          settingSources: ['user', 'user', 'nonsense'],
          skills: [],
          mcpServers: 'yes',
          executablePath: '   ',
        } as never,
        updatedAt: at(1),
      });

      expect(saved.localSetup).toEqual({
        settingSources: ['user'],
        skills: 'none',
        mcpServers: false,
      });
      expect((await storage.settings.get()).localSetup).toEqual(saved.localSetup);
    });
  });

  /* --------------------------- cascade ------------------------- */

  describe('cascade delete', () => {
    it('deleting a team removes its agents and runs, and everything under them', async () => {
      const team = await storage.teams.create(makeTeam());
      const keeper = await storage.teams.create(makeTeam());

      const agent = await storage.agents.create(makeAgent(team.id, { handle: 'a' }));
      const keptAgent = await storage.agents.create(makeAgent(keeper.id, { handle: 'a' }));

      const run = await storage.runs.create(makeRun(team.id));
      const keptRun = await storage.runs.create(makeRun(keeper.id));

      const task = await storage.tasks.create(makeTask(run.id));
      const message = await storage.messages.create(makeMessage(run.id, 1));
      const event = await storage.events.append(makeEvent(run.id, 1));
      const approval = await storage.approvals.create(makeApproval(run.id));

      await storage.teams.delete(team.id);

      expect(await storage.teams.get(team.id)).toBeUndefined();
      expect(await storage.agents.get(agent.id)).toBeUndefined();
      expect(await storage.runs.get(run.id)).toBeUndefined();
      expect(await storage.tasks.get(task.id)).toBeUndefined();
      expect(await storage.messages.get(message.id)).toBeUndefined();
      expect(await storage.events.list({ runId: run.id })).toEqual([]);
      expect(await storage.approvals.get(approval.id)).toBeUndefined();
      expect(await storage.events.countByRun(run.id)).toBe(0);
      expect(event.id).toBeDefined();

      // Untouched neighbours survive.
      expect(await storage.teams.get(keeper.id)).toBeDefined();
      expect(await storage.agents.get(keptAgent.id)).toBeDefined();
      expect(await storage.runs.get(keptRun.id)).toBeDefined();
    });

    it('deleting a run removes its tasks, messages, events and approvals', async () => {
      const { run } = await seed();
      const task = await storage.tasks.create(makeTask(run.id));
      const message = await storage.messages.create(makeMessage(run.id, 1));
      await storage.events.append(makeEvent(run.id, 1));
      const approval = await storage.approvals.create(makeApproval(run.id));

      await storage.runs.delete(run.id);

      expect(await storage.tasks.get(task.id)).toBeUndefined();
      expect(await storage.messages.get(message.id)).toBeUndefined();
      expect(await storage.events.countByRun(run.id)).toBe(0);
      expect(await storage.approvals.get(approval.id)).toBeUndefined();
    });
  });

  /* ---------------------- lossless round-trip ------------------ */

  describe('round-trip', () => {
    it('preserves every field when all optional fields are populated', async () => {
      const team: Team = {
        id: ids.team(),
        name: 'full team',
        description: 'a description',
        orchestratorId: 'ag_orch',
        defaultAgentId: 'ag_default',
        workspace: '/repo',
        budget: { maxTokens: 10, maxCostUsd: 2.5, maxDurationMinutes: 30, maxAgentActivations: 9 },
        presetId: 'preset-x',
        metadata: { nested: { deep: [1, 'two', null, true] }, n: 3 },
        createdAt: at(1),
        updatedAt: at(2),
      };
      expect(await storage.teams.create(team)).toEqual(team);
      expect(await storage.teams.get(team.id)).toEqual(team);

      const agent: Agent = {
        id: ids.agent(),
        teamId: team.id,
        handle: 'full-agent',
        name: 'Full',
        role: 'reviewer',
        description: 'reviews things',
        systemPrompt: 'be thorough',
        model: 'claude-opus-4-8',
        effort: 'max',
        tools: [
          { group: 'filesystem_read', mode: 'allow' },
          { group: 'terminal', mode: 'ask' },
          { group: 'git', mode: 'deny' },
        ],
        workspace: '/repo/sub',
        context: 'extra context',
        memory: { enabled: true, notes: 'remembered things' },
        communicationRules: 'be brief',
        canMessage: ['architect', 'tester'],
        limits: { maxTurns: 5, timeoutMs: 1000, maxMessages: 7 },
        status: 'blocked',
        order: 3,
        templateId: 'tpl-1',
        metadata: { a: 1, b: { c: 'd' } },
        createdAt: at(3),
        updatedAt: at(4),
      };
      expect(await storage.agents.create(agent)).toEqual(agent);
      expect(await storage.agents.get(agent.id)).toEqual(agent);

      const run: Run = {
        id: ids.run(),
        teamId: team.id,
        objective: 'do everything',
        status: 'paused',
        budget: { maxTokens: 1, maxCostUsd: 2, maxDurationMinutes: 3, maxAgentActivations: 4 },
        workspace: '/repo/run',
        agentConfigSnapshot: [
          {
            agentId: agent.id,
            handle: agent.handle,
            name: agent.name,
            role: agent.role,
            model: agent.model,
            effort: agent.effort,
            isOrchestrator: true,
          },
        ],
        totals: {
          usage: {
            inputTokens: 11,
            outputTokens: 22,
            cacheCreationInputTokens: 33,
            cacheReadInputTokens: 44,
          },
          costUsd: 12.5,
          agentActivations: 3,
          toolCalls: 4,
          messages: 5,
        },
        summary: 'summary text',
        error: 'error text',
        retryOfRunId: 'run_previous',
        createdAt: at(5),
        startedAt: at(6),
        completedAt: at(7),
        updatedAt: at(8),
      };
      expect(await storage.runs.create(run)).toEqual(run);
      expect(await storage.runs.get(run.id)).toEqual(run);

      const task: Task = {
        id: ids.task(),
        runId: run.id,
        title: 'full task',
        description: 'a description',
        status: 'review',
        assignedAgentId: agent.id,
        dependencies: ['tsk_a', 'tsk_b'],
        createdBy: 'user',
        result: 'the result',
        error: 'the error',
        attempts: 2,
        maxAttempts: 3,
        reviewerAgentId: 'ag_reviewer',
        order: 4,
        createdAt: at(9),
        updatedAt: at(10),
        startedAt: at(11),
        completedAt: at(12),
      };
      expect(await storage.tasks.create(task)).toEqual(task);
      expect(await storage.tasks.get(task.id)).toEqual(task);

      const message: AgentMessage = {
        id: ids.message(),
        seq: 42,
        runId: run.id,
        from: agent.id,
        to: ['user', 'ag_other'],
        type: 'handoff',
        content: 'take it from here',
        status: 'failed',
        replyTo: 'msg_prev',
        correlationId: 'corr-1',
        taskId: task.id,
        hop: 2,
        path: [agent.id, 'ag_other'],
        error: 'delivery failed',
        createdAt: at(13),
        readAt: at(14),
        completedAt: at(15),
      };
      expect(await storage.messages.create(message)).toEqual(message);
      expect(await storage.messages.get(message.id)).toEqual(message);

      const event: RunEvent = {
        id: ids.event(),
        seq: 43,
        runId: run.id,
        type: 'tool_result',
        agentId: agent.id,
        taskId: task.id,
        messageId: message.id,
        summary: 'ran a tool',
        data: { tool: 'bash', args: ['-c', 'ls'], ok: true },
        model: 'sonnet',
        effort: 'low',
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 4,
        },
        costUsd: 0.5,
        durationMs: 99,
        level: 'error',
        createdAt: at(16),
      };
      expect(await storage.events.append(event)).toEqual(event);
      expect((await storage.events.list({ runId: run.id }))[0]).toEqual(event);

      const approval: ApprovalRequest = {
        id: ids.approval(),
        runId: run.id,
        agentId: agent.id,
        category: 'destructive',
        toolName: 'bash',
        summary: 'delete the world',
        input: { command: 'rm -rf /', cwd: '/' },
        status: 'expired',
        decision: 'allow_always',
        decidedBy: 'user',
        createdAt: at(17),
        resolvedAt: at(18),
        expiresAt: at(19),
      };
      expect(await storage.approvals.create(approval)).toEqual(approval);
      expect(await storage.approvals.get(approval.id)).toEqual(approval);
    });

    it('returns undefined (never null) for every absent optional field', async () => {
      const team: Team = {
        id: ids.team(),
        name: 'bare team',
        metadata: {},
        createdAt: at(1),
        updatedAt: at(2),
      };
      await storage.teams.create(team);
      const storedTeam = (await storage.teams.get(team.id))!;
      expect(storedTeam).toEqual(team);
      for (const key of ['description', 'orchestratorId', 'defaultAgentId', 'workspace', 'budget', 'presetId'] as const) {
        expect(storedTeam[key]).toBeUndefined();
      }

      const agent: Agent = {
        id: ids.agent(),
        teamId: team.id,
        handle: 'bare',
        name: 'Bare',
        role: 'worker',
        systemPrompt: '',
        model: 'sonnet',
        effort: 'low',
        tools: [],
        context: '',
        memory: { enabled: false, notes: '' },
        communicationRules: '',
        canMessage: [],
        limits: {},
        status: 'idle',
        order: 0,
        metadata: {},
        createdAt: at(3),
        updatedAt: at(4),
      };
      await storage.agents.create(agent);
      const storedAgent = (await storage.agents.get(agent.id))!;
      expect(storedAgent).toEqual(agent);
      for (const key of ['description', 'workspace', 'templateId'] as const) {
        expect(storedAgent[key]).toBeUndefined();
      }
      expect(storedAgent.memory.enabled).toBe(false);

      const run: Run = {
        id: ids.run(),
        teamId: team.id,
        objective: 'bare run',
        status: 'queued',
        agentConfigSnapshot: [],
        totals: { usage: emptyUsage(), costUsd: 0, agentActivations: 0, toolCalls: 0, messages: 0 },
        createdAt: at(5),
        updatedAt: at(6),
      };
      await storage.runs.create(run);
      const storedRun = (await storage.runs.get(run.id))!;
      expect(storedRun).toEqual(run);
      for (const key of ['budget', 'workspace', 'summary', 'error', 'retryOfRunId', 'startedAt', 'completedAt'] as const) {
        expect(storedRun[key]).toBeUndefined();
      }

      const task: Task = {
        id: ids.task(),
        runId: run.id,
        title: 'bare task',
        description: '',
        status: 'pending',
        dependencies: [],
        createdBy: 'user',
        attempts: 0,
        maxAttempts: 1,
        order: 0,
        createdAt: at(7),
        updatedAt: at(8),
      };
      await storage.tasks.create(task);
      const storedTask = (await storage.tasks.get(task.id))!;
      expect(storedTask).toEqual(task);
      for (const key of ['assignedAgentId', 'result', 'error', 'reviewerAgentId', 'startedAt', 'completedAt'] as const) {
        expect(storedTask[key]).toBeUndefined();
      }

      const message: AgentMessage = {
        id: ids.message(),
        seq: 1,
        runId: run.id,
        from: 'user',
        to: ['ada'],
        type: 'message',
        content: 'hi',
        status: 'pending',
        hop: 0,
        path: [],
        createdAt: at(9),
      };
      await storage.messages.create(message);
      const storedMessage = (await storage.messages.get(message.id))!;
      expect(storedMessage).toEqual(message);
      for (const key of ['replyTo', 'correlationId', 'taskId', 'error', 'readAt', 'completedAt'] as const) {
        expect(storedMessage[key]).toBeUndefined();
      }

      const event: RunEvent = {
        id: ids.event(),
        seq: 1,
        runId: run.id,
        type: 'log',
        summary: '',
        data: {},
        level: 'debug',
        createdAt: at(10),
      };
      await storage.events.append(event);
      const storedEvent = (await storage.events.list({ runId: run.id }))[0]!;
      expect(storedEvent).toEqual(event);
      for (const key of ['agentId', 'taskId', 'messageId', 'model', 'effort', 'usage', 'costUsd', 'durationMs'] as const) {
        expect(storedEvent[key]).toBeUndefined();
      }

      const approval: ApprovalRequest = {
        id: ids.approval(),
        runId: run.id,
        agentId: 'ag_1',
        category: 'shell',
        toolName: 'bash',
        summary: '',
        input: {},
        status: 'pending',
        createdAt: at(11),
      };
      await storage.approvals.create(approval);
      const storedApproval = (await storage.approvals.get(approval.id))!;
      expect(storedApproval).toEqual(approval);
      for (const key of ['decision', 'decidedBy', 'resolvedAt', 'expiresAt'] as const) {
        expect(storedApproval[key]).toBeUndefined();
      }
    });

    it('returns real Date objects', async () => {
      const { run } = await seed();
      const stored = (await storage.runs.get(run.id))!;
      expect(stored.createdAt).toBeInstanceOf(Date);
      expect(stored.updatedAt).toBeInstanceOf(Date);
      expect(stored.createdAt.getTime()).toBe(run.createdAt.getTime());
    });
  });
});

/* ------------------------------------------------------------------ *
 * Driver-specific expectations
 * ------------------------------------------------------------------ */

describe('SqliteStorage', () => {
  it('describes itself as the sqlite driver at the configured location', () => {
    const storage = new SqliteStorage({ location: ':memory:' });
    expect(storage.describe()).toEqual({ driver: 'sqlite', location: ':memory:' });
  });

  it('falls back to the default database path', () => {
    const storage = new SqliteStorage({});
    expect(storage.describe().location).toMatch(/claude-team\.db$/);
  });
});

describe('defaultDbPath', () => {
  const original = process.env['CLAUDE_TEAM_HOME'];

  afterEach(() => {
    if (original === undefined) delete process.env['CLAUDE_TEAM_HOME'];
    else process.env['CLAUDE_TEAM_HOME'] = original;
  });

  it('respects CLAUDE_TEAM_HOME', async () => {
    const { defaultDbPath } = await import('./sqlite-storage.js');
    process.env['CLAUDE_TEAM_HOME'] = '/tmp/claude-team-test-home';
    expect(defaultDbPath()).toBe('/tmp/claude-team-test-home/claude-team.db');

    delete process.env['CLAUDE_TEAM_HOME'];
    expect(defaultDbPath()).toMatch(/[/]\.claude-team[/]claude-team\.db$/);
  });
});

describe('InMemoryStorage', () => {
  it('describes itself as the memory driver', () => {
    expect(new InMemoryStorage().describe()).toEqual({ driver: 'memory', location: ':memory:' });
  });
});

describe('migrations', () => {
  let db: Database;

  beforeEach(() => {
    db = new SqliteDatabase(':memory:') as Database;
  });

  afterEach(() => {
    if (db.open) db.close();
  });

  it('records what it applied and applies each migration exactly once', () => {
    applyMigrations(db);

    const rows = db.prepare('SELECT id, name, applied_at FROM _migrations ORDER BY id').all() as Array<{
      id: number;
      name: string;
      applied_at: number;
    }>;
    expect(rows.map((r) => r.name)).toEqual(migrations.map((m) => m.name));
    expect(rows[0]!.name).toBe('001_initial');
    expect(rows[0]!.applied_at).toBeGreaterThan(0);

    // Re-running is a no-op; if it re-ran `001_initial` the CREATE TABLE would throw.
    applyMigrations(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n).toBe(
      migrations.length,
    );
  });

  it('applies only the migrations that are missing', () => {
    applyMigrations(db);

    let ran = false;
    applyMigrations(db, [
      ...migrations,
      { id: 999, name: '999_probe', up: (d) => { ran = true; d.exec('CREATE TABLE probe (x TEXT)'); } },
    ]);

    expect(ran).toBe(true);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'probe'").get(),
    ).toBeDefined();
  });

  it('enables the expected pragmas', () => {
    applyMigrations(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('rolls a failing migration back', () => {
    expect(() =>
      applyMigrations(db, [
        {
          id: 1,
          name: '001_initial',
          up: (d) => {
            d.exec('CREATE TABLE half (x TEXT)');
            throw new Error('boom');
          },
        },
      ]),
    ).toThrow('boom');

    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half'").get(),
    ).toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n).toBe(0);
  });
});

describe('SqliteStorage on disk', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-team-persist-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates missing parent directories and survives a reopen', async () => {
    const location = join(dir, 'nested', 'deeper', 'claude-team.db');

    const first = new SqliteStorage({ location });
    await first.init();
    const team = await first.teams.create(makeTeam({ name: 'persisted' }));
    const run = await first.runs.create(makeRun(team.id));
    expect(await first.messages.nextSeq(run.id)).toBe(1);
    await first.close();

    const second = new SqliteStorage({ location });
    await second.init();
    expect((await second.teams.findByName('persisted'))?.id).toBe(team.id);
    // Sequences survive a restart, so `#n` never repeats within a run.
    expect(await second.messages.nextSeq(run.id)).toBe(2);
    expect(second.describe()).toEqual({ driver: 'sqlite', location });

    const raw = new SqliteDatabase(location) as Database;
    expect(String(raw.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    raw.close();
    await second.close();
  });
});
