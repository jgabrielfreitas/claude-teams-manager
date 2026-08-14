import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import SqliteDatabase from 'better-sqlite3';

import type {
  Agent,
  AgentConfigSnapshot,
  AgentEffort,
  AgentLimits,
  AgentMessage,
  AgentMessageStatus,
  AgentMessageType,
  AgentStatus,
  AppSettings,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalStatus,
  Budget,
  Run,
  RunEvent,
  RunEventType,
  RunStatus,
  RunTotals,
  Task,
  TaskStatus,
  Team,
  TokenUsage,
} from '@claude-team/domain';
import { defaultSettings } from '@claude-team/domain';

import { applyMigrations, applyPragmas, type Database } from './migrations.js';
import type {
  AgentRepository,
  ApprovalRepository,
  EventListFilter,
  EventRepository,
  MessageListFilter,
  MessageRepository,
  RunListFilter,
  RunRepository,
  SettingsRepository,
  Storage,
  TaskRepository,
  TeamRepository,
} from './storage.js';

export const MEMORY_LOCATION = ':memory:';

/**
 * Where the database lives by default. `CLAUDE_TEAM_HOME` replaces the
 * `~/.claude-team` directory wholesale, which is what the test harness and
 * anyone running several instances side by side needs.
 */
export function defaultDbPath(): string {
  const override = process.env['CLAUDE_TEAM_HOME']?.trim();
  const home = override && override.length > 0 ? override : join(homedir(), '.claude-team');
  return join(home, 'claude-team.db');
}

/* ------------------------------------------------------------------ *
 * Row helpers
 * ------------------------------------------------------------------ */

type Row = Record<string, unknown>;
type Bindable = string | number | null;
type BindRow = Record<string, Bindable>;

const QUOTED_COLUMNS = new Set(['order']);

function col(name: string): string {
  return QUOTED_COLUMNS.has(name) ? `"${name}"` : name;
}

function insertSql(table: string, columns: readonly string[]): string {
  const names = columns.map(col).join(', ');
  const params = columns.map((c) => `@${c}`).join(', ');
  return `INSERT INTO ${table} (${names}) VALUES (${params})`;
}

function updateSql(table: string, columns: readonly string[]): string {
  const sets = columns
    .filter((c) => c !== 'id')
    .map((c) => `${col(c)} = @${c}`)
    .join(', ');
  return `UPDATE ${table} SET ${sets} WHERE id = @id`;
}

/* reading ---------------------------------------------------------- */

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function optStr(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : String(v);
}

function int(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}

function optNum(v: unknown): number | undefined {
  return v === null || v === undefined ? undefined : Number(v);
}

function bool(v: unknown): boolean {
  return Number(v) !== 0;
}

function date(v: unknown): Date {
  return new Date(Number(v));
}

function optDate(v: unknown): Date | undefined {
  return v === null || v === undefined ? undefined : new Date(Number(v));
}

function json<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  try {
    const parsed = JSON.parse(String(v)) as T | null;
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function optJson<T>(v: unknown): T | undefined {
  if (v === null || v === undefined) return undefined;
  try {
    const parsed = JSON.parse(String(v)) as T | null;
    return parsed === null ? undefined : parsed;
  } catch {
    return undefined;
  }
}

/* writing ---------------------------------------------------------- */

function bStr(v: string | undefined | null): string | null {
  return v === undefined || v === null ? null : v;
}

function bNum(v: number | undefined | null): number | null {
  return v === undefined || v === null ? null : v;
}

function bBool(v: boolean): number {
  return v ? 1 : 0;
}

function bDate(v: Date | undefined | null): number | null {
  return v === undefined || v === null ? null : v.getTime();
}

function bJson(v: unknown): string {
  return JSON.stringify(v ?? null);
}

function bOptJson(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

/** `LIMIT/OFFSET` fragment; SQLite requires a LIMIT whenever OFFSET is present. */
function limitClause(opts: { limit?: number; offset?: number } | undefined): {
  sql: string;
  params: number[];
} {
  const limit = opts?.limit;
  const offset = opts?.offset;
  if (limit === undefined && offset === undefined) return { sql: '', params: [] };
  return { sql: ' LIMIT ? OFFSET ?', params: [limit ?? -1, offset ?? 0] };
}

function notFound(kind: string, id: string): Error {
  return new Error(`${kind} ${id} not found`);
}

/* ------------------------------------------------------------------ *
 * Column lists + mappers
 * ------------------------------------------------------------------ */

const TEAM_COLUMNS = [
  'id',
  'name',
  'description',
  'orchestrator_id',
  'default_agent_id',
  'workspace',
  'budget',
  'preset_id',
  'metadata',
  'created_at',
  'updated_at',
] as const;

function teamToRow(t: Team): BindRow {
  return {
    id: t.id,
    name: t.name,
    description: bStr(t.description),
    orchestrator_id: bStr(t.orchestratorId),
    default_agent_id: bStr(t.defaultAgentId),
    workspace: bStr(t.workspace),
    budget: bOptJson(t.budget),
    preset_id: bStr(t.presetId),
    metadata: bJson(t.metadata ?? {}),
    created_at: t.createdAt.getTime(),
    updated_at: t.updatedAt.getTime(),
  };
}

function rowToTeam(r: Row): Team {
  return {
    id: str(r['id']),
    name: str(r['name']),
    description: optStr(r['description']),
    orchestratorId: optStr(r['orchestrator_id']),
    defaultAgentId: optStr(r['default_agent_id']),
    workspace: optStr(r['workspace']),
    budget: optJson<Budget>(r['budget']),
    presetId: optStr(r['preset_id']),
    metadata: json<Record<string, unknown>>(r['metadata'], {}),
    createdAt: date(r['created_at']),
    updatedAt: date(r['updated_at']),
  };
}

const AGENT_COLUMNS = [
  'id',
  'team_id',
  'handle',
  'name',
  'role',
  'description',
  'system_prompt',
  'model',
  'effort',
  'tools',
  'workspace',
  'context',
  'memory_enabled',
  'memory_notes',
  'communication_rules',
  'can_message',
  'limits',
  'status',
  'order',
  'template_id',
  'metadata',
  'created_at',
  'updated_at',
] as const;

function agentToRow(a: Agent): BindRow {
  return {
    id: a.id,
    team_id: a.teamId,
    handle: a.handle,
    name: a.name,
    role: a.role,
    description: bStr(a.description),
    system_prompt: a.systemPrompt,
    model: a.model,
    effort: a.effort,
    tools: bJson(a.tools ?? []),
    workspace: bStr(a.workspace),
    context: a.context,
    memory_enabled: bBool(a.memory.enabled),
    memory_notes: a.memory.notes,
    communication_rules: a.communicationRules,
    can_message: bJson(a.canMessage ?? []),
    limits: bJson(a.limits ?? {}),
    status: a.status,
    order: a.order,
    template_id: bStr(a.templateId),
    metadata: bJson(a.metadata ?? {}),
    created_at: a.createdAt.getTime(),
    updated_at: a.updatedAt.getTime(),
  };
}

function rowToAgent(r: Row): Agent {
  return {
    id: str(r['id']),
    teamId: str(r['team_id']),
    handle: str(r['handle']),
    name: str(r['name']),
    role: str(r['role']),
    description: optStr(r['description']),
    systemPrompt: str(r['system_prompt']),
    model: str(r['model']),
    effort: str(r['effort']) as AgentEffort,
    tools: json<Agent['tools']>(r['tools'], []),
    workspace: optStr(r['workspace']),
    context: str(r['context']),
    memory: { enabled: bool(r['memory_enabled']), notes: str(r['memory_notes']) },
    communicationRules: str(r['communication_rules']),
    canMessage: json<string[]>(r['can_message'], []),
    limits: json<AgentLimits>(r['limits'], {}),
    status: str(r['status']) as AgentStatus,
    order: int(r['order']),
    templateId: optStr(r['template_id']),
    metadata: json<Record<string, unknown>>(r['metadata'], {}),
    createdAt: date(r['created_at']),
    updatedAt: date(r['updated_at']),
  };
}

const RUN_COLUMNS = [
  'id',
  'team_id',
  'objective',
  'status',
  'budget',
  'workspace',
  'agent_config_snapshot',
  'totals',
  'summary',
  'error',
  'retry_of_run_id',
  'created_at',
  'started_at',
  'completed_at',
  'updated_at',
] as const;

function runToRow(run: Run): BindRow {
  return {
    id: run.id,
    team_id: run.teamId,
    objective: run.objective,
    status: run.status,
    budget: bOptJson(run.budget),
    workspace: bStr(run.workspace),
    agent_config_snapshot: bJson(run.agentConfigSnapshot ?? []),
    totals: bJson(run.totals),
    summary: bStr(run.summary),
    error: bStr(run.error),
    retry_of_run_id: bStr(run.retryOfRunId),
    created_at: run.createdAt.getTime(),
    started_at: bDate(run.startedAt),
    completed_at: bDate(run.completedAt),
    updated_at: run.updatedAt.getTime(),
  };
}

const EMPTY_TOTALS: RunTotals = {
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  costUsd: 0,
  agentActivations: 0,
  toolCalls: 0,
  messages: 0,
};

function rowToRun(r: Row): Run {
  return {
    id: str(r['id']),
    teamId: str(r['team_id']),
    objective: str(r['objective']),
    status: str(r['status']) as RunStatus,
    budget: optJson<Budget>(r['budget']),
    workspace: optStr(r['workspace']),
    agentConfigSnapshot: json<AgentConfigSnapshot[]>(r['agent_config_snapshot'], []),
    totals: json<RunTotals>(r['totals'], { ...EMPTY_TOTALS, usage: { ...EMPTY_TOTALS.usage } }),
    summary: optStr(r['summary']),
    error: optStr(r['error']),
    retryOfRunId: optStr(r['retry_of_run_id']),
    createdAt: date(r['created_at']),
    startedAt: optDate(r['started_at']),
    completedAt: optDate(r['completed_at']),
    updatedAt: date(r['updated_at']),
  };
}

const TASK_COLUMNS = [
  'id',
  'run_id',
  'title',
  'description',
  'status',
  'assigned_agent_id',
  'dependencies',
  'created_by',
  'result',
  'error',
  'attempts',
  'max_attempts',
  'reviewer_agent_id',
  'order',
  'created_at',
  'updated_at',
  'started_at',
  'completed_at',
] as const;

function taskToRow(t: Task): BindRow {
  return {
    id: t.id,
    run_id: t.runId,
    title: t.title,
    description: t.description,
    status: t.status,
    assigned_agent_id: bStr(t.assignedAgentId),
    dependencies: bJson(t.dependencies ?? []),
    created_by: t.createdBy,
    result: bStr(t.result),
    error: bStr(t.error),
    attempts: t.attempts,
    max_attempts: t.maxAttempts,
    reviewer_agent_id: bStr(t.reviewerAgentId),
    order: t.order,
    created_at: t.createdAt.getTime(),
    updated_at: t.updatedAt.getTime(),
    started_at: bDate(t.startedAt),
    completed_at: bDate(t.completedAt),
  };
}

function rowToTask(r: Row): Task {
  return {
    id: str(r['id']),
    runId: str(r['run_id']),
    title: str(r['title']),
    description: str(r['description']),
    status: str(r['status']) as TaskStatus,
    assignedAgentId: optStr(r['assigned_agent_id']),
    dependencies: json<string[]>(r['dependencies'], []),
    createdBy: str(r['created_by']),
    result: optStr(r['result']),
    error: optStr(r['error']),
    attempts: int(r['attempts']),
    maxAttempts: int(r['max_attempts']),
    reviewerAgentId: optStr(r['reviewer_agent_id']),
    order: int(r['order']),
    createdAt: date(r['created_at']),
    updatedAt: date(r['updated_at']),
    startedAt: optDate(r['started_at']),
    completedAt: optDate(r['completed_at']),
  };
}

const MESSAGE_COLUMNS = [
  'id',
  'seq',
  'run_id',
  'from_participant',
  'to_participants',
  'type',
  'content',
  'status',
  'reply_to',
  'correlation_id',
  'task_id',
  'hop',
  'path',
  'error',
  'created_at',
  'read_at',
  'completed_at',
] as const;

function messageToRow(m: AgentMessage): BindRow {
  return {
    id: m.id,
    seq: m.seq,
    run_id: m.runId,
    from_participant: m.from,
    to_participants: bJson(m.to ?? []),
    type: m.type,
    content: m.content,
    status: m.status,
    reply_to: bStr(m.replyTo),
    correlation_id: bStr(m.correlationId),
    task_id: bStr(m.taskId),
    hop: m.hop,
    path: bJson(m.path ?? []),
    error: bStr(m.error),
    created_at: m.createdAt.getTime(),
    read_at: bDate(m.readAt),
    completed_at: bDate(m.completedAt),
  };
}

function rowToMessage(r: Row): AgentMessage {
  return {
    id: str(r['id']),
    seq: int(r['seq']),
    runId: str(r['run_id']),
    from: str(r['from_participant']),
    to: json<string[]>(r['to_participants'], []),
    type: str(r['type']) as AgentMessageType,
    content: str(r['content']),
    status: str(r['status']) as AgentMessageStatus,
    replyTo: optStr(r['reply_to']),
    correlationId: optStr(r['correlation_id']),
    taskId: optStr(r['task_id']),
    hop: int(r['hop']),
    path: json<string[]>(r['path'], []),
    error: optStr(r['error']),
    createdAt: date(r['created_at']),
    readAt: optDate(r['read_at']),
    completedAt: optDate(r['completed_at']),
  };
}

const EVENT_COLUMNS = [
  'id',
  'seq',
  'run_id',
  'type',
  'agent_id',
  'task_id',
  'message_id',
  'summary',
  'data',
  'model',
  'effort',
  'usage',
  'cost_usd',
  'duration_ms',
  'level',
  'created_at',
] as const;

function eventToRow(e: RunEvent): BindRow {
  return {
    id: e.id,
    seq: e.seq,
    run_id: e.runId,
    type: e.type,
    agent_id: bStr(e.agentId),
    task_id: bStr(e.taskId),
    message_id: bStr(e.messageId),
    summary: e.summary,
    data: bJson(e.data ?? {}),
    model: bStr(e.model),
    effort: bStr(e.effort),
    usage: bOptJson(e.usage),
    cost_usd: bNum(e.costUsd),
    duration_ms: bNum(e.durationMs),
    level: e.level,
    created_at: e.createdAt.getTime(),
  };
}

function rowToEvent(r: Row): RunEvent {
  return {
    id: str(r['id']),
    seq: int(r['seq']),
    runId: str(r['run_id']),
    type: str(r['type']) as RunEventType,
    agentId: optStr(r['agent_id']),
    taskId: optStr(r['task_id']),
    messageId: optStr(r['message_id']),
    summary: str(r['summary']),
    data: json<Record<string, unknown>>(r['data'], {}),
    model: optStr(r['model']),
    effort: optStr(r['effort']) as AgentEffort | undefined,
    usage: optJson<TokenUsage>(r['usage']),
    costUsd: optNum(r['cost_usd']),
    durationMs: optNum(r['duration_ms']),
    level: str(r['level']) as RunEvent['level'],
    createdAt: date(r['created_at']),
  };
}

const APPROVAL_COLUMNS = [
  'id',
  'run_id',
  'agent_id',
  'category',
  'tool_name',
  'summary',
  'input',
  'status',
  'decision',
  'decided_by',
  'created_at',
  'resolved_at',
  'expires_at',
] as const;

function approvalToRow(a: ApprovalRequest): BindRow {
  return {
    id: a.id,
    run_id: a.runId,
    agent_id: a.agentId,
    category: a.category,
    tool_name: a.toolName,
    summary: a.summary,
    input: bJson(a.input ?? {}),
    status: a.status,
    decision: bStr(a.decision),
    decided_by: bStr(a.decidedBy),
    created_at: a.createdAt.getTime(),
    resolved_at: bDate(a.resolvedAt),
    expires_at: bDate(a.expiresAt),
  };
}

function rowToApproval(r: Row): ApprovalRequest {
  return {
    id: str(r['id']),
    runId: str(r['run_id']),
    agentId: str(r['agent_id']),
    category: str(r['category']),
    toolName: str(r['tool_name']),
    summary: str(r['summary']),
    input: json<Record<string, unknown>>(r['input'], {}),
    status: str(r['status']) as ApprovalStatus,
    decision: optStr(r['decision']) as ApprovalDecision | undefined,
    decidedBy: optStr(r['decided_by']),
    createdAt: date(r['created_at']),
    resolvedAt: optDate(r['resolved_at']),
    expiresAt: optDate(r['expires_at']),
  };
}

const SETTINGS_COLUMNS = [
  'id',
  'onboarding_completed',
  'default_workspace',
  'default_model',
  'default_orchestrator_model',
  'default_effort',
  'provider',
  'default_budget',
  'require_approval_for',
  'auto_approve_all',
  'max_hops',
  'max_recursion_depth',
  'ask_timeout_ms',
  'web_port',
  'theme',
  'telemetry',
  'updated_at',
] as const;

function settingsToRow(s: AppSettings): BindRow {
  return {
    id: 1,
    onboarding_completed: bBool(s.onboardingCompleted),
    default_workspace: bStr(s.defaultWorkspace),
    default_model: s.defaultModel,
    default_orchestrator_model: s.defaultOrchestratorModel,
    default_effort: s.defaultEffort,
    provider: s.provider,
    default_budget: bJson(s.defaultBudget ?? {}),
    require_approval_for: bJson(s.requireApprovalFor ?? []),
    auto_approve_all: bBool(s.autoApproveAll),
    max_hops: s.maxHops,
    max_recursion_depth: s.maxRecursionDepth,
    ask_timeout_ms: s.askTimeoutMs,
    web_port: s.webPort,
    theme: s.theme,
    telemetry: bBool(s.telemetry),
    updated_at: s.updatedAt.getTime(),
  };
}

function rowToSettings(r: Row): AppSettings {
  return {
    onboardingCompleted: bool(r['onboarding_completed']),
    defaultWorkspace: optStr(r['default_workspace']),
    defaultModel: str(r['default_model']),
    defaultOrchestratorModel: str(r['default_orchestrator_model']),
    defaultEffort: str(r['default_effort']) as AgentEffort,
    provider: str(r['provider']),
    defaultBudget: json<Budget>(r['default_budget'], {}),
    requireApprovalFor: json<string[]>(r['require_approval_for'], []),
    autoApproveAll: bool(r['auto_approve_all']),
    maxHops: int(r['max_hops']),
    maxRecursionDepth: int(r['max_recursion_depth']),
    askTimeoutMs: int(r['ask_timeout_ms']),
    webPort: int(r['web_port']),
    theme: str(r['theme']) as AppSettings['theme'],
    telemetry: bool(r['telemetry']),
    updatedAt: date(r['updated_at']),
  };
}

/* ------------------------------------------------------------------ *
 * Repositories
 * ------------------------------------------------------------------ */

class SqliteTeamRepository implements TeamRepository {
  constructor(private readonly db: () => Database) {}

  async list(): Promise<Team[]> {
    const rows = this.db()
      .prepare('SELECT * FROM teams ORDER BY created_at ASC, rowid ASC')
      .all() as Row[];
    return rows.map(rowToTeam);
  }

  async get(id: string): Promise<Team | undefined> {
    const row = this.db().prepare('SELECT * FROM teams WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToTeam(row) : undefined;
  }

  async findByName(name: string): Promise<Team | undefined> {
    const row = this.db()
      .prepare('SELECT * FROM teams WHERE name = ? ORDER BY created_at ASC, rowid ASC LIMIT 1')
      .get(name) as Row | undefined;
    return row ? rowToTeam(row) : undefined;
  }

  async create(team: Team): Promise<Team> {
    this.db().prepare(insertSql('teams', TEAM_COLUMNS)).run(teamToRow(team));
    return (await this.get(team.id))!;
  }

  async update(team: Team): Promise<Team> {
    const res = this.db().prepare(updateSql('teams', TEAM_COLUMNS)).run(teamToRow(team));
    if (res.changes === 0) throw notFound('Team', team.id);
    return (await this.get(team.id))!;
  }

  async delete(id: string): Promise<void> {
    this.db().prepare('DELETE FROM teams WHERE id = ?').run(id);
  }
}

class SqliteAgentRepository implements AgentRepository {
  constructor(private readonly db: () => Database) {}

  async listAll(): Promise<Agent[]> {
    const rows = this.db()
      .prepare('SELECT * FROM agents ORDER BY team_id ASC, "order" ASC, created_at ASC, rowid ASC')
      .all() as Row[];
    return rows.map(rowToAgent);
  }

  async listByTeam(teamId: string): Promise<Agent[]> {
    const rows = this.db()
      .prepare(
        'SELECT * FROM agents WHERE team_id = ? ORDER BY "order" ASC, created_at ASC, rowid ASC',
      )
      .all(teamId) as Row[];
    return rows.map(rowToAgent);
  }

  async get(id: string): Promise<Agent | undefined> {
    const row = this.db().prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToAgent(row) : undefined;
  }

  async getByHandle(teamId: string, handle: string): Promise<Agent | undefined> {
    const row = this.db()
      .prepare('SELECT * FROM agents WHERE team_id = ? AND handle = ?')
      .get(teamId, handle) as Row | undefined;
    return row ? rowToAgent(row) : undefined;
  }

  async create(agent: Agent): Promise<Agent> {
    this.db().prepare(insertSql('agents', AGENT_COLUMNS)).run(agentToRow(agent));
    return (await this.get(agent.id))!;
  }

  async update(agent: Agent): Promise<Agent> {
    const res = this.db().prepare(updateSql('agents', AGENT_COLUMNS)).run(agentToRow(agent));
    if (res.changes === 0) throw notFound('Agent', agent.id);
    return (await this.get(agent.id))!;
  }

  async delete(id: string): Promise<void> {
    this.db().prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  async resetStatuses(): Promise<void> {
    this.db().prepare("UPDATE agents SET status = 'idle'").run();
  }
}

class SqliteRunRepository implements RunRepository {
  constructor(private readonly db: () => Database) {}

  async list(filter?: RunListFilter): Promise<Run[]> {
    const where: string[] = [];
    const params: Bindable[] = [];

    if (filter?.teamId) {
      where.push('team_id = ?');
      params.push(filter.teamId);
    }
    if (filter?.status && filter.status.length > 0) {
      where.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
      params.push(...filter.status);
    }

    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const page = limitClause(filter);
    const rows = this.db()
      .prepare(
        `SELECT * FROM runs${clause} ORDER BY created_at DESC, rowid DESC${page.sql}`,
      )
      .all(...params, ...page.params) as Row[];
    return rows.map(rowToRun);
  }

  async get(id: string): Promise<Run | undefined> {
    const row = this.db().prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToRun(row) : undefined;
  }

  async create(run: Run): Promise<Run> {
    this.db().prepare(insertSql('runs', RUN_COLUMNS)).run(runToRow(run));
    return (await this.get(run.id))!;
  }

  async update(run: Run): Promise<Run> {
    const res = this.db().prepare(updateSql('runs', RUN_COLUMNS)).run(runToRow(run));
    if (res.changes === 0) throw notFound('Run', run.id);
    return (await this.get(run.id))!;
  }

  async delete(id: string): Promise<void> {
    const db = this.db();
    const tx = db.transaction((runId: string) => {
      db.prepare('DELETE FROM sequences WHERE run_id = ?').run(runId);
      db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
    });
    tx(id);
  }

  async listInterrupted(): Promise<Run[]> {
    const rows = this.db()
      .prepare(
        `SELECT * FROM runs WHERE status IN ('queued', 'running', 'paused')
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all() as Row[];
    return rows.map(rowToRun);
  }
}

class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly db: () => Database) {}

  async listByRun(runId: string): Promise<Task[]> {
    const rows = this.db()
      .prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY "order" ASC, created_at ASC, rowid ASC')
      .all(runId) as Row[];
    return rows.map(rowToTask);
  }

  async get(id: string): Promise<Task | undefined> {
    const row = this.db().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToTask(row) : undefined;
  }

  async create(task: Task): Promise<Task> {
    this.db().prepare(insertSql('tasks', TASK_COLUMNS)).run(taskToRow(task));
    return (await this.get(task.id))!;
  }

  async createMany(tasks: Task[]): Promise<Task[]> {
    const db = this.db();
    const stmt = db.prepare(insertSql('tasks', TASK_COLUMNS));
    const tx = db.transaction((list: Task[]) => {
      for (const task of list) stmt.run(taskToRow(task));
    });
    tx(tasks);
    const out: Task[] = [];
    for (const task of tasks) out.push((await this.get(task.id))!);
    return out;
  }

  async update(task: Task): Promise<Task> {
    const res = this.db().prepare(updateSql('tasks', TASK_COLUMNS)).run(taskToRow(task));
    if (res.changes === 0) throw notFound('Task', task.id);
    return (await this.get(task.id))!;
  }

  async updateMany(tasks: Task[]): Promise<void> {
    const db = this.db();
    const stmt = db.prepare(updateSql('tasks', TASK_COLUMNS));
    const tx = db.transaction((list: Task[]) => {
      for (const task of list) {
        const res = stmt.run(taskToRow(task));
        if (res.changes === 0) throw notFound('Task', task.id);
      }
    });
    tx(tasks);
  }

  async delete(id: string): Promise<void> {
    this.db().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }
}

/** Shared by both sequence allocators. Single statement, therefore atomic. */
function allocateSeq(db: Database, runId: string, kind: string): number {
  const row = db
    .prepare(
      `INSERT INTO sequences (run_id, kind, value) VALUES (?, ?, 1)
       ON CONFLICT(run_id, kind) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get(runId, kind) as Row | undefined;
  return int(row?.['value']);
}

class SqliteMessageRepository implements MessageRepository {
  constructor(private readonly db: () => Database) {}

  async list(filter?: MessageListFilter): Promise<AgentMessage[]> {
    const where: string[] = [];
    const params: Bindable[] = [];

    if (filter?.runId) {
      where.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter?.fromParticipant) {
      where.push('from_participant = ?');
      params.push(filter.fromParticipant);
    }
    if (filter?.toParticipant) {
      where.push(
        'EXISTS (SELECT 1 FROM json_each(messages.to_participants) WHERE json_each.value = ?)',
      );
      params.push(filter.toParticipant);
    }
    if (filter?.afterSeq !== undefined) {
      where.push('seq > ?');
      params.push(filter.afterSeq);
    }

    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const page = limitClause(filter);
    const rows = this.db()
      .prepare(`SELECT * FROM messages${clause} ORDER BY seq ASC, rowid ASC${page.sql}`)
      .all(...params, ...page.params) as Row[];
    return rows.map(rowToMessage);
  }

  async get(id: string): Promise<AgentMessage | undefined> {
    const row = this.db().prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToMessage(row) : undefined;
  }

  async create(message: AgentMessage): Promise<AgentMessage> {
    this.db().prepare(insertSql('messages', MESSAGE_COLUMNS)).run(messageToRow(message));
    return (await this.get(message.id))!;
  }

  async update(message: AgentMessage): Promise<AgentMessage> {
    const res = this.db().prepare(updateSql('messages', MESSAGE_COLUMNS)).run(messageToRow(message));
    if (res.changes === 0) throw notFound('Message', message.id);
    return (await this.get(message.id))!;
  }

  async countByRun(runId: string): Promise<number> {
    const row = this.db()
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id = ?')
      .get(runId) as Row;
    return int(row['n']);
  }

  async nextSeq(runId: string): Promise<number> {
    return allocateSeq(this.db(), runId, 'message');
  }
}

class SqliteEventRepository implements EventRepository {
  constructor(private readonly db: () => Database) {}

  async list(filter?: EventListFilter): Promise<RunEvent[]> {
    const where: string[] = [];
    const params: Bindable[] = [];

    if (filter?.runId) {
      where.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter?.afterSeq !== undefined) {
      where.push('seq > ?');
      params.push(filter.afterSeq);
    }
    if (filter?.types && filter.types.length > 0) {
      where.push(`type IN (${filter.types.map(() => '?').join(', ')})`);
      params.push(...filter.types);
    }
    if (filter?.agentId) {
      where.push('agent_id = ?');
      params.push(filter.agentId);
    }

    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const page = limitClause(filter);
    const rows = this.db()
      .prepare(`SELECT * FROM events${clause} ORDER BY seq ASC, rowid ASC${page.sql}`)
      .all(...params, ...page.params) as Row[];
    return rows.map(rowToEvent);
  }

  async append(event: RunEvent): Promise<RunEvent> {
    const db = this.db();
    db.prepare(insertSql('events', EVENT_COLUMNS)).run(eventToRow(event));
    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(event.id) as Row;
    return rowToEvent(row);
  }

  async countByRun(runId: string): Promise<number> {
    const row = this.db()
      .prepare('SELECT COUNT(*) AS n FROM events WHERE run_id = ?')
      .get(runId) as Row;
    return int(row['n']);
  }

  async nextSeq(runId: string): Promise<number> {
    return allocateSeq(this.db(), runId, 'event');
  }

  async recent(limit: number): Promise<RunEvent[]> {
    const rows = this.db()
      .prepare('SELECT * FROM events ORDER BY created_at DESC, seq DESC, rowid DESC LIMIT ?')
      .all(limit) as Row[];
    return rows.map(rowToEvent);
  }
}

class SqliteApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: () => Database) {}

  async list(filter?: { runId?: string; status?: string }): Promise<ApprovalRequest[]> {
    const where: string[] = [];
    const params: Bindable[] = [];

    if (filter?.runId) {
      where.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter?.status) {
      where.push('status = ?');
      params.push(filter.status);
    }

    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const rows = this.db()
      .prepare(`SELECT * FROM approvals${clause} ORDER BY created_at ASC, rowid ASC`)
      .all(...params) as Row[];
    return rows.map(rowToApproval);
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    const row = this.db().prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToApproval(row) : undefined;
  }

  async create(approval: ApprovalRequest): Promise<ApprovalRequest> {
    this.db().prepare(insertSql('approvals', APPROVAL_COLUMNS)).run(approvalToRow(approval));
    return (await this.get(approval.id))!;
  }

  async update(approval: ApprovalRequest): Promise<ApprovalRequest> {
    const res = this.db()
      .prepare(updateSql('approvals', APPROVAL_COLUMNS))
      .run(approvalToRow(approval));
    if (res.changes === 0) throw notFound('Approval', approval.id);
    return (await this.get(approval.id))!;
  }
}

class SqliteSettingsRepository implements SettingsRepository {
  constructor(private readonly db: () => Database) {}

  async get(): Promise<AppSettings> {
    const db = this.db();
    const row = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Row | undefined;
    if (row) return rowToSettings(row);
    const fresh = defaultSettings();
    db.prepare(insertSql('settings', SETTINGS_COLUMNS)).run(settingsToRow(fresh));
    const stored = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Row;
    return rowToSettings(stored);
  }

  async save(settings: AppSettings): Promise<AppSettings> {
    const db = this.db();
    const columns = SETTINGS_COLUMNS.map(col).join(', ');
    const params = SETTINGS_COLUMNS.map((c) => `@${c}`).join(', ');
    db.prepare(`INSERT OR REPLACE INTO settings (${columns}) VALUES (${params})`).run(
      settingsToRow(settings),
    );
    const row = db.prepare('SELECT * FROM settings WHERE id = 1').get() as Row;
    return rowToSettings(row);
  }
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

export interface SqliteStorageOptions {
  location?: string;
}

export class SqliteStorage implements Storage {
  readonly location: string;

  private db: Database | undefined;
  private initialised = false;

  readonly teams: TeamRepository;
  readonly agents: AgentRepository;
  readonly runs: RunRepository;
  readonly tasks: TaskRepository;
  readonly messages: MessageRepository;
  readonly events: EventRepository;
  readonly approvals: ApprovalRepository;
  readonly settings: SettingsRepository;

  constructor(opts: SqliteStorageOptions = {}) {
    this.location = opts.location?.trim() || defaultDbPath();

    const handle = () => this.connection();
    this.teams = new SqliteTeamRepository(handle);
    this.agents = new SqliteAgentRepository(handle);
    this.runs = new SqliteRunRepository(handle);
    this.tasks = new SqliteTaskRepository(handle);
    this.messages = new SqliteMessageRepository(handle);
    this.events = new SqliteEventRepository(handle);
    this.approvals = new SqliteApprovalRepository(handle);
    this.settings = new SqliteSettingsRepository(handle);
  }

  /** Opens the connection on first use, so that `describe()` is free. */
  private connection(): Database {
    if (this.db) return this.db;

    if (this.location !== MEMORY_LOCATION) {
      mkdirSync(dirname(this.location), { recursive: true });
    }
    const db = new SqliteDatabase(this.location) as Database;
    applyPragmas(db);
    this.db = db;
    return db;
  }

  async init(): Promise<void> {
    const db = this.connection();
    if (this.initialised) return;
    applyMigrations(db);
    this.initialised = true;
  }

  async close(): Promise<void> {
    if (this.db && this.db.open) this.db.close();
    this.db = undefined;
    this.initialised = false;
  }

  describe(): { driver: string; location: string } {
    return { driver: 'sqlite', location: this.location };
  }
}
