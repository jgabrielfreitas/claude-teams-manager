import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_LIMITS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_ROUTING_LIMITS,
  allTasksSettled,
  assertNoCycle,
  availableRunActions,
  canMessage,
  canTransitionRun,
  checkRoute,
  cloneAgent,
  coerceEffort,
  createAgent,
  createMessage,
  createTask,
  createTeam,
  danglingDependencies,
  estimateCostUsd,
  findCycles,
  inboxFor,
  isStalled,
  looksDestructive,
  parsePortableTeam,
  permissionMode,
  permissionsFromGroups,
  readyTasks,
  recomputeTaskStatuses,
  slugify,
  taskProgress,
  toPortableTeam,
  topologicalOrder,
  uniqueSlug,
  unreadCount,
  type Agent,
  type Task,
} from './index.js';

/* ------------------------------------------------------------------ *
 * Agents and teams
 * ------------------------------------------------------------------ */

describe('agent creation', () => {
  it('applies sensible defaults and derives a unique handle', () => {
    const agent = createAgent({ teamId: 'tm_1', name: 'Backend Engineer', role: 'Backend' });

    expect(agent.handle).toBe('backend-engineer');
    expect(agent.model).toBe(DEFAULT_MODEL);
    expect(agent.effort).toBe(DEFAULT_EFFORT);
    expect(agent.status).toBe('idle');
    expect(agent.canMessage).toEqual(['*']);
    expect(agent.limits).toEqual(DEFAULT_AGENT_LIMITS);
    expect(agent.systemPrompt).toContain('Backend Engineer');
    expect(agent.id.startsWith('ag_')).toBe(true);
  });

  it('never reuses a handle already taken in the team', () => {
    const first = createAgent({ teamId: 't', name: 'Backend', role: 'r' }, []);
    const second = createAgent({ teamId: 't', name: 'Backend', role: 'r' }, [first.handle]);
    const third = createAgent({ teamId: 't', name: 'Backend', role: 'r' }, [
      first.handle,
      second.handle,
    ]);

    expect(new Set([first.handle, second.handle, third.handle]).size).toBe(3);
    expect(second.handle).toBe('backend-2');
  });

  it('rejects an agent without a name or a role', () => {
    expect(() => createAgent({ teamId: 't', name: '  ', role: 'r' })).toThrow(/name is required/i);
    expect(() => createAgent({ teamId: 't', name: 'n', role: '' })).toThrow(/role is required/i);
    expect(() => createAgent({ teamId: '', name: 'n', role: 'r' })).toThrow(/team/i);
  });

  it('clones an agent with a fresh identity and an empty memory', () => {
    const source = createAgent({
      teamId: 't',
      name: 'Backend',
      role: 'Backend Engineer',
      model: 'opus',
      effort: 'max',
      memory: { enabled: true, notes: 'learned something' },
    });

    const copy = cloneAgent(source, { name: 'Backend Payments' }, [source.handle]);

    expect(copy.id).not.toBe(source.id);
    expect(copy.handle).not.toBe(source.handle);
    // Configuration is carried over...
    expect(copy.model).toBe('opus');
    expect(copy.effort).toBe('max');
    expect(copy.systemPrompt).toBe(source.systemPrompt);
    // ...but memory is about work already done, so it does not follow.
    expect(copy.memory.notes).toBe('');
  });

  it('keeps model and effort independent between agents', () => {
    const architect = createAgent({
      teamId: 't',
      name: 'Architect',
      role: 'Architect',
      model: 'opus',
      effort: 'max',
    });
    const frontend = createAgent(
      { teamId: 't', name: 'Frontend', role: 'Frontend', model: 'haiku', effort: 'low' },
      [architect.handle],
    );

    expect(architect.model).toBe('opus');
    expect(architect.effort).toBe('max');
    expect(frontend.model).toBe('haiku');
    expect(frontend.effort).toBe('low');
  });
});

describe('team creation', () => {
  it('trims and requires a name', () => {
    const team = createTeam({ name: '  Engineering  ' });
    expect(team.name).toBe('Engineering');
    expect(() => createTeam({ name: '' })).toThrow(/name is required/i);
  });
});

describe('effort configuration', () => {
  it('coerces loose input to a valid level', () => {
    expect(coerceEffort('HIGH')).toBe('high');
    expect(coerceEffort('maximum')).toBe('max');
    expect(coerceEffort('xhigh')).toBe('max');
    expect(coerceEffort('balanced')).toBe('medium');
    expect(coerceEffort(0)).toBe('low');
    expect(coerceEffort(undefined)).toBe(DEFAULT_EFFORT);
    expect(coerceEffort('nonsense', 'high')).toBe('high');
  });
});

describe('slugs', () => {
  it('normalises accents and punctuation', () => {
    expect(slugify('Análise de Dados!')).toBe('analise-de-dados');
    expect(uniqueSlug('qa', ['qa', 'qa-2'])).toBe('qa-3');
  });
});

describe('cost estimation', () => {
  it('prices a known model and declines an unknown one', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    expect(estimateCostUsd('sonnet', usage)).toBeCloseTo(18, 5);
    expect(estimateCostUsd('some-future-model', usage)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Permissions
 * ------------------------------------------------------------------ */

describe('capability permissions', () => {
  it('builds a permission set from allowed groups', () => {
    const permissions = permissionsFromGroups(['filesystem_read', 'terminal'], {
      askInsteadOfAllow: ['terminal'],
    });

    expect(permissionMode(permissions, 'filesystem_read')).toBe('allow');
    expect(permissionMode(permissions, 'terminal')).toBe('ask');
    expect(permissionMode(permissions, 'filesystem_write')).toBe('deny');
  });

  it('recognises destructive shell commands', () => {
    expect(looksDestructive('rm -rf ./generated')).toBe(true);
    expect(looksDestructive('git reset --hard origin/main')).toBe(true);
    expect(looksDestructive('DROP TABLE users')).toBe(true);
    expect(looksDestructive('ls -la')).toBe(false);
    expect(looksDestructive('npm test')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Message routing
 * ------------------------------------------------------------------ */

function agentFixture(handle: string, canMessageList: string[] = ['*']): Agent {
  return createAgent({
    teamId: 't',
    handle,
    name: handle,
    role: 'role',
    canMessage: canMessageList,
  });
}

describe('message routing', () => {
  const architect = agentFixture('architect');
  const backend = agentFixture('backend', ['architect', 'frontend']);
  const frontend = agentFixture('frontend', ['backend']);
  const reviewer = agentFixture('reviewer', []);

  it('honours canMessage, including the wildcard', () => {
    expect(canMessage(architect, 'backend')).toBe(true);
    expect(canMessage(backend, 'architect')).toBe(true);
    expect(canMessage(backend, 'reviewer')).toBe(false);
    expect(canMessage(reviewer, 'architect')).toBe(false);
    // The human is always reachable, and nobody messages themselves.
    expect(canMessage(reviewer, 'user')).toBe(true);
    expect(canMessage(backend, 'backend')).toBe(false);
  });

  it('rejects a recipient the sender may not address', () => {
    const result = checkRoute({
      sender: backend,
      recipients: [architect, reviewer],
      hop: 0,
      path: [backend.id],
      messagesInRun: 0,
      limits: DEFAULT_ROUTING_LIMITS,
    });

    expect(result.allowed.map((a) => a.handle)).toEqual(['architect']);
    expect(result.rejections[0]).toMatchObject({ code: 'permission_denied', recipient: 'reviewer' });
  });

  it('stops a chain that exceeded the hop limit', () => {
    const result = checkRoute({
      sender: architect,
      recipients: [backend],
      hop: DEFAULT_ROUTING_LIMITS.maxHops,
      path: [architect.id],
      messagesInRun: 0,
      limits: DEFAULT_ROUTING_LIMITS,
    });

    expect(result.allowed).toHaveLength(0);
    expect(result.rejections[0].code).toBe('hop_limit_exceeded');
  });

  it('refuses a synchronous ask that would return to a waiting agent', () => {
    // architect asked backend; backend must not be able to ask architect back.
    const result = checkRoute({
      sender: backend,
      recipients: [architect],
      hop: 1,
      path: [architect.id, backend.id],
      messagesInRun: 0,
      limits: DEFAULT_ROUTING_LIMITS,
      depth: 1,
    });

    expect(result.allowed).toHaveLength(0);
    expect(result.rejections[0].code).toBe('cycle_detected');
  });

  it('caps nested synchronous asks', () => {
    const result = checkRoute({
      sender: architect,
      recipients: [frontend],
      hop: 0,
      path: [architect.id],
      messagesInRun: 0,
      limits: DEFAULT_ROUTING_LIMITS,
      depth: DEFAULT_ROUTING_LIMITS.maxRecursionDepth,
    });

    expect(result.rejections[0].code).toBe('recursion_limit');
  });

  it('stops once the run hit its message limit', () => {
    const result = checkRoute({
      sender: architect,
      recipients: [backend],
      hop: 0,
      path: [architect.id],
      messagesInRun: DEFAULT_ROUTING_LIMITS.maxMessagesPerRun,
      limits: DEFAULT_ROUTING_LIMITS,
    });

    expect(result.rejections[0].code).toBe('message_limit');
  });

  it('builds an inbox and counts what is unread', () => {
    const base = { runId: 'r', from: architect.id, content: 'hello' };
    const messages = [
      createMessage({ ...base, seq: 2, to: [backend.id] }),
      createMessage({ ...base, seq: 1, to: [backend.id, frontend.id] }),
      createMessage({ ...base, seq: 3, to: [frontend.id] }),
    ];
    messages[1].status = 'read';

    const inbox = inboxFor(backend.id, messages);
    expect(inbox.map((m) => m.seq)).toEqual([1, 2]);
    expect(unreadCount(backend.id, messages)).toBe(1);
  });

  it('refuses to create an empty or unaddressed message', () => {
    expect(() => createMessage({ runId: 'r', seq: 1, from: 'a', to: ['b'], content: '  ' })).toThrow();
    expect(() => createMessage({ runId: 'r', seq: 1, from: 'a', to: [], content: 'x' })).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * Task dependency resolution
 * ------------------------------------------------------------------ */

function taskFixture(title: string, dependencies: string[] = [], id?: string): Task {
  const task = createTask({ runId: 'r', title, createdBy: 'user', dependencies });
  if (id) task.id = id;
  return task;
}

describe('task dependency resolution', () => {
  it('marks a task ready only when every dependency completed', () => {
    const a = taskFixture('A', [], 'a');
    const b = taskFixture('B', ['a'], 'b');
    const c = taskFixture('C', ['a', 'b'], 'c');
    const tasks = [a, b, c];

    expect(a.status).toBe('ready');
    expect(b.status).toBe('pending');

    a.status = 'completed';
    recomputeTaskStatuses(tasks);
    expect(b.status).toBe('ready');
    expect(c.status).toBe('pending');

    b.status = 'completed';
    recomputeTaskStatuses(tasks);
    expect(c.status).toBe('ready');
    expect(readyTasks(tasks).map((t) => t.id)).toEqual(['c']);
  });

  it('blocks dependents of a failed task, and unblocks them on retry', () => {
    const a = taskFixture('A', [], 'a');
    const b = taskFixture('B', ['a'], 'b');
    const tasks = [a, b];

    a.status = 'failed';
    recomputeTaskStatuses(tasks);
    expect(b.status).toBe('blocked');

    a.status = 'completed';
    recomputeTaskStatuses(tasks);
    expect(b.status).toBe('ready');
  });

  it('detects cycles and refuses to introduce one', () => {
    const a = taskFixture('A', ['b'], 'a');
    const b = taskFixture('B', ['a'], 'b');

    expect(findCycles([a, b]).length).toBeGreaterThan(0);
    expect(() => assertNoCycle([taskFixture('A', [], 'a'), taskFixture('B', ['a'], 'b')], 'a', ['b'])).toThrow(
      /cycle/i,
    );
  });

  it('reports dependencies that do not exist', () => {
    const a = taskFixture('A', ['ghost'], 'a');
    expect(danglingDependencies([a])).toEqual([{ taskId: 'a', missing: ['ghost'] }]);
  });

  it('orders dependencies before dependents', () => {
    const a = taskFixture('A', [], 'a');
    const b = taskFixture('B', ['a'], 'b');
    const c = taskFixture('C', ['b'], 'c');
    expect(topologicalOrder([c, b, a]).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('recognises a settled and a stalled graph', () => {
    const a = taskFixture('A', [], 'a');
    const b = taskFixture('B', ['a'], 'b');

    expect(allTasksSettled([a, b])).toBe(false);
    expect(isStalled([a, b])).toBe(false);

    a.status = 'failed';
    recomputeTaskStatuses([a, b]);
    expect(isStalled([a, b])).toBe(true);

    b.status = 'cancelled';
    expect(allTasksSettled([a, b])).toBe(true);
    expect(isStalled([a, b])).toBe(false);
  });

  it('summarises progress', () => {
    const tasks = [taskFixture('A', [], 'a'), taskFixture('B', [], 'b'), taskFixture('C', [], 'c')];
    tasks[0].status = 'completed';
    tasks[1].status = 'running';
    expect(taskProgress(tasks)).toMatchObject({ total: 3, completed: 1, running: 1, percent: 33 });
  });
});

/* ------------------------------------------------------------------ *
 * State machines
 * ------------------------------------------------------------------ */

describe('run state machine', () => {
  it('allows only legal transitions', () => {
    expect(canTransitionRun('queued', 'running')).toBe(true);
    expect(canTransitionRun('running', 'paused')).toBe(true);
    expect(canTransitionRun('paused', 'running')).toBe(true);
    expect(canTransitionRun('completed', 'running')).toBe(false);
    expect(canTransitionRun('cancelled', 'running')).toBe(false);
  });

  it('offers the actions a UI should show', () => {
    expect(availableRunActions('running')).toEqual(['pause', 'cancel']);
    expect(availableRunActions('paused')).toEqual(['resume', 'cancel']);
    expect(availableRunActions('completed')).toEqual(['retry']);
  });
});

/* ------------------------------------------------------------------ *
 * Portable team format
 * ------------------------------------------------------------------ */

describe('portable team format', () => {
  it('round-trips a team through export and import', () => {
    const team = createTeam({ name: 'Engineering', workspace: '/tmp/app' });
    const architect = createAgent({
      teamId: team.id,
      handle: 'architect',
      name: 'Architect',
      role: 'Software Architect',
      model: 'opus',
      effort: 'high',
      canMessage: ['*'],
    });
    const backend = createAgent(
      {
        teamId: team.id,
        handle: 'backend',
        name: 'Backend',
        role: 'Backend Engineer',
        model: 'sonnet',
        effort: 'medium',
        canMessage: ['architect'],
      },
      ['architect'],
    );
    team.orchestratorId = architect.id;

    const doc = toPortableTeam(team, [architect, backend]);
    expect(doc.orchestrator).toBe('architect');
    expect(doc.agents.backend.model).toBe('sonnet');

    const parsed = parsePortableTeam(JSON.parse(JSON.stringify(doc)));
    expect(parsed.team.name).toBe('Engineering');
    expect(parsed.orchestratorHandle).toBe('architect');
    expect(parsed.agents.map((a) => a.handle)).toEqual(['architect', 'backend']);
    expect(parsed.agents[0].effort).toBe('high');
    expect(parsed.agents[1].effort).toBe('medium');
    expect(parsed.warnings).toHaveLength(0);
  });

  it('accepts the documented shorthand format', () => {
    const parsed = parsePortableTeam({
      name: 'engineering',
      orchestrator: 'architect',
      agents: {
        architect: { role: 'Software Architect', model: 'claude-opus', effort: 'high' },
        backend: { role: 'Backend Engineer', model: 'claude-sonnet', effort: 'medium' },
      },
    });

    expect(parsed.agents).toHaveLength(2);
    expect(parsed.agents[0].model).toBe('claude-opus');
    expect(parsed.orchestratorHandle).toBe('architect');
  });

  it('warns instead of failing on an unknown reference', () => {
    const parsed = parsePortableTeam({
      name: 'team',
      orchestrator: 'ghost',
      agents: { a: { role: 'r', can_message: ['b', 'ghost'] }, b: { role: 'r' } },
    });

    expect(parsed.orchestratorHandle).toBeUndefined();
    expect(parsed.agents[0].canMessage).toEqual(['b']);
    expect(parsed.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects a document that is not a team', () => {
    expect(() => parsePortableTeam({ nope: true })).toThrow(/invalid team file/i);
    expect(() => parsePortableTeam({ name: 'x', agents: {} })).toThrow(/at least one agent/i);
  });
});
