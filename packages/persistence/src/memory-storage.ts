import type {
  Agent,
  AgentMessage,
  AgentQuestion,
  AppSettings,
  ApprovalRequest,
  Run,
  RunEvent,
  Task,
  Team,
} from '@claude-team/domain';
import { defaultSettings } from '@claude-team/domain';

import type {
  AgentRepository,
  ApprovalRepository,
  EventListFilter,
  EventRepository,
  ListOptions,
  MessageListFilter,
  MessageRepository,
  QuestionRepository,
  RunListFilter,
  RunRepository,
  SettingsRepository,
  Storage,
  TaskRepository,
  TeamRepository,
} from './storage.js';

/**
 * Reference implementation of `Storage` backed by plain Maps.
 *
 * It exists so the whole runtime can be exercised without touching disk, and it
 * is held to exactly the same conformance suite as the SQLite driver. Entities
 * are deep-cloned on the way in and on the way out, so a caller can never
 * mutate stored state by holding on to a returned object.
 */

/** `structuredClone` preserves `Date`, which `JSON.parse(JSON.stringify(...))` does not. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

function paginate<T>(items: T[], opts: ListOptions | undefined): T[] {
  const offset = opts?.offset ?? 0;
  const sliced = offset > 0 ? items.slice(offset) : items;
  const limit = opts?.limit;
  return limit === undefined || limit < 0 ? sliced : sliced.slice(0, limit);
}

function notFound(kind: string, id: string): Error {
  return new Error(`${kind} ${id} not found`);
}

/** Stable ordering helper: compare by `key`, falling back to insertion order. */
function byThenInserted<T>(items: T[], compare: (a: T, b: T) => number): T[] {
  return items
    .map((value, index) => ({ value, index }))
    .sort((a, b) => compare(a.value, b.value) || a.index - b.index)
    .map((e) => e.value);
}

interface Tables {
  teams: Map<string, Team>;
  agents: Map<string, Agent>;
  runs: Map<string, Run>;
  tasks: Map<string, Task>;
  messages: Map<string, AgentMessage>;
  events: Map<string, RunEvent>;
  approvals: Map<string, ApprovalRequest>;
  questions: Map<string, AgentQuestion>;
  sequences: Map<string, number>;
  settings: AppSettings | undefined;
}

function seqKey(runId: string, kind: string): string {
  return `${kind}:${runId}`;
}

/* ------------------------------------------------------------------ *
 * Repositories
 * ------------------------------------------------------------------ */

class MemoryTeamRepository implements TeamRepository {
  constructor(private readonly t: Tables) {}

  async list(): Promise<Team[]> {
    return byThenInserted(
      [...this.t.teams.values()],
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    ).map(clone);
  }

  async get(id: string): Promise<Team | undefined> {
    const found = this.t.teams.get(id);
    return found ? clone(found) : undefined;
  }

  async findByName(name: string): Promise<Team | undefined> {
    const all = await this.list();
    return all.find((t) => t.name === name);
  }

  async create(team: Team): Promise<Team> {
    if (this.t.teams.has(team.id)) throw new Error(`Team ${team.id} already exists`);
    this.t.teams.set(team.id, clone(team));
    return clone(team);
  }

  async update(team: Team): Promise<Team> {
    if (!this.t.teams.has(team.id)) throw notFound('Team', team.id);
    this.t.teams.set(team.id, clone(team));
    return clone(team);
  }

  async delete(id: string): Promise<void> {
    if (!this.t.teams.delete(id)) return;
    // ON DELETE CASCADE, by hand.
    for (const agent of [...this.t.agents.values()]) {
      if (agent.teamId === id) this.t.agents.delete(agent.id);
    }
    for (const run of [...this.t.runs.values()]) {
      if (run.teamId === id) deleteRunCascade(this.t, run.id);
    }
  }
}

function deleteRunCascade(t: Tables, runId: string): void {
  t.runs.delete(runId);
  for (const task of [...t.tasks.values()]) if (task.runId === runId) t.tasks.delete(task.id);
  for (const m of [...t.messages.values()]) if (m.runId === runId) t.messages.delete(m.id);
  for (const e of [...t.events.values()]) if (e.runId === runId) t.events.delete(e.id);
  for (const a of [...t.approvals.values()]) if (a.runId === runId) t.approvals.delete(a.id);
  for (const q of [...t.questions.values()]) if (q.runId === runId) t.questions.delete(q.id);
  t.sequences.delete(seqKey(runId, 'message'));
  t.sequences.delete(seqKey(runId, 'event'));
}

class MemoryAgentRepository implements AgentRepository {
  constructor(private readonly t: Tables) {}

  private ordered(agents: Agent[]): Agent[] {
    return byThenInserted(
      agents,
      (a, b) => a.order - b.order || a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }

  async listAll(): Promise<Agent[]> {
    const grouped = byThenInserted([...this.t.agents.values()], (a, b) =>
      a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : a.order - b.order,
    );
    return grouped.map(clone);
  }

  async listByTeam(teamId: string): Promise<Agent[]> {
    const list = [...this.t.agents.values()].filter((a) => a.teamId === teamId);
    return this.ordered(list).map(clone);
  }

  async get(id: string): Promise<Agent | undefined> {
    const found = this.t.agents.get(id);
    return found ? clone(found) : undefined;
  }

  async getByHandle(teamId: string, handle: string): Promise<Agent | undefined> {
    const found = [...this.t.agents.values()].find(
      (a) => a.teamId === teamId && a.handle === handle,
    );
    return found ? clone(found) : undefined;
  }

  private assertHandleFree(agent: Agent): void {
    const clash = [...this.t.agents.values()].find(
      (a) => a.teamId === agent.teamId && a.handle === agent.handle && a.id !== agent.id,
    );
    if (clash) {
      throw new Error(
        `UNIQUE constraint failed: agents.team_id, agents.handle (${agent.teamId}/${agent.handle})`,
      );
    }
  }

  async create(agent: Agent): Promise<Agent> {
    if (this.t.agents.has(agent.id)) throw new Error(`Agent ${agent.id} already exists`);
    this.assertHandleFree(agent);
    this.t.agents.set(agent.id, clone(agent));
    return clone(agent);
  }

  async update(agent: Agent): Promise<Agent> {
    if (!this.t.agents.has(agent.id)) throw notFound('Agent', agent.id);
    this.assertHandleFree(agent);
    this.t.agents.set(agent.id, clone(agent));
    return clone(agent);
  }

  async delete(id: string): Promise<void> {
    this.t.agents.delete(id);
  }

  async resetStatuses(): Promise<void> {
    for (const [id, agent] of this.t.agents) {
      this.t.agents.set(id, { ...agent, status: 'idle' });
    }
  }
}

const INTERRUPTED_STATUSES = new Set<Run['status']>(['queued', 'running', 'paused']);

class MemoryRunRepository implements RunRepository {
  constructor(private readonly t: Tables) {}

  private newestFirst(runs: Run[]): Run[] {
    return runs
      .map((value, index) => ({ value, index }))
      .sort((a, b) => b.value.createdAt.getTime() - a.value.createdAt.getTime() || b.index - a.index)
      .map((e) => e.value);
  }

  async list(filter?: RunListFilter): Promise<Run[]> {
    let runs = [...this.t.runs.values()];
    if (filter?.teamId) runs = runs.filter((r) => r.teamId === filter.teamId);
    if (filter?.status && filter.status.length > 0) {
      const wanted = new Set(filter.status);
      runs = runs.filter((r) => wanted.has(r.status));
    }
    return paginate(this.newestFirst(runs), filter).map(clone);
  }

  async get(id: string): Promise<Run | undefined> {
    const found = this.t.runs.get(id);
    return found ? clone(found) : undefined;
  }

  async create(run: Run): Promise<Run> {
    if (this.t.runs.has(run.id)) throw new Error(`Run ${run.id} already exists`);
    this.t.runs.set(run.id, clone(run));
    return clone(run);
  }

  async update(run: Run): Promise<Run> {
    if (!this.t.runs.has(run.id)) throw notFound('Run', run.id);
    this.t.runs.set(run.id, clone(run));
    return clone(run);
  }

  async delete(id: string): Promise<void> {
    deleteRunCascade(this.t, id);
  }

  async listInterrupted(): Promise<Run[]> {
    const runs = [...this.t.runs.values()].filter((r) => INTERRUPTED_STATUSES.has(r.status));
    return this.newestFirst(runs).map(clone);
  }
}

class MemoryTaskRepository implements TaskRepository {
  constructor(private readonly t: Tables) {}

  async listByRun(runId: string): Promise<Task[]> {
    const list = [...this.t.tasks.values()].filter((t) => t.runId === runId);
    return byThenInserted(
      list,
      (a, b) => a.order - b.order || a.createdAt.getTime() - b.createdAt.getTime(),
    ).map(clone);
  }

  async get(id: string): Promise<Task | undefined> {
    const found = this.t.tasks.get(id);
    return found ? clone(found) : undefined;
  }

  async create(task: Task): Promise<Task> {
    if (this.t.tasks.has(task.id)) throw new Error(`Task ${task.id} already exists`);
    this.t.tasks.set(task.id, clone(task));
    return clone(task);
  }

  async createMany(tasks: Task[]): Promise<Task[]> {
    const out: Task[] = [];
    for (const task of tasks) out.push(await this.create(task));
    return out;
  }

  async update(task: Task): Promise<Task> {
    if (!this.t.tasks.has(task.id)) throw notFound('Task', task.id);
    this.t.tasks.set(task.id, clone(task));
    return clone(task);
  }

  async updateMany(tasks: Task[]): Promise<void> {
    for (const task of tasks) {
      if (!this.t.tasks.has(task.id)) throw notFound('Task', task.id);
    }
    for (const task of tasks) this.t.tasks.set(task.id, clone(task));
  }

  async delete(id: string): Promise<void> {
    this.t.tasks.delete(id);
  }
}

class MemoryMessageRepository implements MessageRepository {
  constructor(private readonly t: Tables) {}

  async list(filter?: MessageListFilter): Promise<AgentMessage[]> {
    let list = [...this.t.messages.values()];
    if (filter?.runId) list = list.filter((m) => m.runId === filter.runId);
    if (filter?.fromParticipant) list = list.filter((m) => m.from === filter.fromParticipant);
    if (filter?.toParticipant) {
      list = list.filter((m) => m.to.includes(filter.toParticipant as string));
    }
    if (filter?.afterSeq !== undefined) {
      const after = filter.afterSeq;
      list = list.filter((m) => m.seq > after);
    }
    return paginate(byThenInserted(list, (a, b) => a.seq - b.seq), filter).map(clone);
  }

  async get(id: string): Promise<AgentMessage | undefined> {
    const found = this.t.messages.get(id);
    return found ? clone(found) : undefined;
  }

  async create(message: AgentMessage): Promise<AgentMessage> {
    if (this.t.messages.has(message.id)) throw new Error(`Message ${message.id} already exists`);
    this.t.messages.set(message.id, clone(message));
    return clone(message);
  }

  async update(message: AgentMessage): Promise<AgentMessage> {
    if (!this.t.messages.has(message.id)) throw notFound('Message', message.id);
    this.t.messages.set(message.id, clone(message));
    return clone(message);
  }

  async countByRun(runId: string): Promise<number> {
    let n = 0;
    for (const m of this.t.messages.values()) if (m.runId === runId) n += 1;
    return n;
  }

  async nextSeq(runId: string): Promise<number> {
    const key = seqKey(runId, 'message');
    const next = (this.t.sequences.get(key) ?? 0) + 1;
    this.t.sequences.set(key, next);
    return next;
  }
}

class MemoryEventRepository implements EventRepository {
  constructor(private readonly t: Tables) {}

  async list(filter?: EventListFilter): Promise<RunEvent[]> {
    let list = [...this.t.events.values()];
    if (filter?.runId) list = list.filter((e) => e.runId === filter.runId);
    if (filter?.afterSeq !== undefined) {
      const after = filter.afterSeq;
      list = list.filter((e) => e.seq > after);
    }
    if (filter?.types && filter.types.length > 0) {
      const wanted = new Set(filter.types);
      list = list.filter((e) => wanted.has(e.type));
    }
    if (filter?.agentId) list = list.filter((e) => e.agentId === filter.agentId);
    return paginate(byThenInserted(list, (a, b) => a.seq - b.seq), filter).map(clone);
  }

  async append(event: RunEvent): Promise<RunEvent> {
    if (this.t.events.has(event.id)) throw new Error(`Event ${event.id} already exists`);
    this.t.events.set(event.id, clone(event));
    return clone(event);
  }

  async countByRun(runId: string): Promise<number> {
    let n = 0;
    for (const e of this.t.events.values()) if (e.runId === runId) n += 1;
    return n;
  }

  async nextSeq(runId: string): Promise<number> {
    const key = seqKey(runId, 'event');
    const next = (this.t.sequences.get(key) ?? 0) + 1;
    this.t.sequences.set(key, next);
    return next;
  }

  async recent(limit: number): Promise<RunEvent[]> {
    return [...this.t.events.values()]
      .map((value, index) => ({ value, index }))
      .sort(
        (a, b) =>
          b.value.createdAt.getTime() - a.value.createdAt.getTime() ||
          b.value.seq - a.value.seq ||
          b.index - a.index,
      )
      .slice(0, Math.max(0, limit))
      .map((e) => clone(e.value));
  }
}

class MemoryApprovalRepository implements ApprovalRepository {
  constructor(private readonly t: Tables) {}

  async list(filter?: { runId?: string; status?: string }): Promise<ApprovalRequest[]> {
    let list = [...this.t.approvals.values()];
    if (filter?.runId) list = list.filter((a) => a.runId === filter.runId);
    if (filter?.status) list = list.filter((a) => a.status === filter.status);
    return byThenInserted(list, (a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(clone);
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    const found = this.t.approvals.get(id);
    return found ? clone(found) : undefined;
  }

  async create(approval: ApprovalRequest): Promise<ApprovalRequest> {
    if (this.t.approvals.has(approval.id)) throw new Error(`Approval ${approval.id} already exists`);
    this.t.approvals.set(approval.id, clone(approval));
    return clone(approval);
  }

  async update(approval: ApprovalRequest): Promise<ApprovalRequest> {
    if (!this.t.approvals.has(approval.id)) throw notFound('Approval', approval.id);
    this.t.approvals.set(approval.id, clone(approval));
    return clone(approval);
  }
}

class MemoryQuestionRepository implements QuestionRepository {
  constructor(private readonly t: Tables) {}

  async list(filter?: { runId?: string; status?: string }): Promise<AgentQuestion[]> {
    let list = [...this.t.questions.values()];
    if (filter?.runId) list = list.filter((q) => q.runId === filter.runId);
    if (filter?.status) list = list.filter((q) => q.status === filter.status);
    return byThenInserted(list, (a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(clone);
  }

  async get(id: string): Promise<AgentQuestion | undefined> {
    const found = this.t.questions.get(id);
    return found ? clone(found) : undefined;
  }

  async create(question: AgentQuestion): Promise<AgentQuestion> {
    if (this.t.questions.has(question.id)) throw new Error(`Question ${question.id} already exists`);
    this.t.questions.set(question.id, clone(question));
    return clone(question);
  }

  async update(question: AgentQuestion): Promise<AgentQuestion> {
    if (!this.t.questions.has(question.id)) throw notFound('Question', question.id);
    this.t.questions.set(question.id, clone(question));
    return clone(question);
  }
}

class MemorySettingsRepository implements SettingsRepository {
  constructor(private readonly t: Tables) {}

  async get(): Promise<AppSettings> {
    if (!this.t.settings) this.t.settings = defaultSettings();
    return clone(this.t.settings);
  }

  async save(settings: AppSettings): Promise<AppSettings> {
    this.t.settings = clone(settings);
    return clone(settings);
  }
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

export class InMemoryStorage implements Storage {
  private readonly tables: Tables = {
    teams: new Map(),
    agents: new Map(),
    runs: new Map(),
    tasks: new Map(),
    messages: new Map(),
    events: new Map(),
    approvals: new Map(),
    questions: new Map(),
    sequences: new Map(),
    settings: undefined,
  };

  readonly teams: TeamRepository = new MemoryTeamRepository(this.tables);
  readonly agents: AgentRepository = new MemoryAgentRepository(this.tables);
  readonly runs: RunRepository = new MemoryRunRepository(this.tables);
  readonly tasks: TaskRepository = new MemoryTaskRepository(this.tables);
  readonly messages: MessageRepository = new MemoryMessageRepository(this.tables);
  readonly events: EventRepository = new MemoryEventRepository(this.tables);
  readonly approvals: ApprovalRepository = new MemoryApprovalRepository(this.tables);
  readonly questions: QuestionRepository = new MemoryQuestionRepository(this.tables);
  readonly settings: SettingsRepository = new MemorySettingsRepository(this.tables);

  async init(): Promise<void> {
    /* nothing to migrate */
  }

  async close(): Promise<void> {
    /* nothing to close */
  }

  describe(): { driver: string; location: string } {
    return { driver: 'memory', location: ':memory:' };
  }
}
