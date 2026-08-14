import { ids, slugify, uniqueSlug } from './ids.js';
import { invalid } from './errors.js';
import { DEFAULT_EFFORT, coerceEffort, type AgentEffort } from './effort.js';
import { DEFAULT_MODEL } from './models.js';
import { defaultToolPermissions, type ToolPermission } from './permissions.js';
import { emptyUsage } from './models.js';
import type {
  Agent,
  AgentLimits,
  AgentMemory,
  AgentMessage,
  AgentMessageType,
  ApprovalRequest,
  Budget,
  Run,
  RunEvent,
  RunEventType,
  Task,
  Team,
} from './entities.js';

/* ------------------------------------------------------------------ *
 * Agents
 * ------------------------------------------------------------------ */

export interface CreateAgentInput {
  teamId: string;
  name: string;
  role: string;
  handle?: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  effort?: AgentEffort | string;
  tools?: ToolPermission[];
  workspace?: string;
  context?: string;
  memory?: Partial<AgentMemory>;
  communicationRules?: string;
  canMessage?: string[];
  limits?: AgentLimits;
  order?: number;
  templateId?: string;
  metadata?: Record<string, unknown>;
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxTurns: 30,
  timeoutMs: 15 * 60 * 1000,
  maxMessages: 100,
};

/**
 * Builds a valid `Agent`. `existingHandles` is used to guarantee handle
 * uniqueness inside the team; the caller passes the team's current handles.
 */
export function createAgent(input: CreateAgentInput, existingHandles: string[] = [], now = new Date()): Agent {
  const name = input.name?.trim();
  if (!name) throw invalid('Agent name is required');
  const role = input.role?.trim();
  if (!role) throw invalid('Agent role is required');
  if (!input.teamId) throw invalid('Agent must belong to a team');

  const desiredHandle = input.handle ? slugify(input.handle) : slugify(name);
  const handle = uniqueSlug(desiredHandle, existingHandles);

  return {
    id: ids.agent(),
    teamId: input.teamId,
    handle,
    name,
    role,
    description: input.description?.trim() || undefined,
    systemPrompt: (input.systemPrompt ?? defaultSystemPrompt(name, role)).trim(),
    model: input.model?.trim() || DEFAULT_MODEL,
    effort: coerceEffort(input.effort, DEFAULT_EFFORT),
    tools: input.tools ?? defaultToolPermissions(),
    workspace: input.workspace?.trim() || undefined,
    context: input.context ?? '',
    memory: { enabled: input.memory?.enabled ?? true, notes: input.memory?.notes ?? '' },
    communicationRules: input.communicationRules ?? '',
    canMessage: normaliseCanMessage(input.canMessage ?? ['*']),
    limits: { ...DEFAULT_AGENT_LIMITS, ...(input.limits ?? {}) },
    status: 'idle',
    order: input.order ?? existingHandles.length,
    templateId: input.templateId,
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };
}

export function defaultSystemPrompt(name: string, role: string): string {
  return [
    `You are ${name}, the ${role} of this team.`,
    '',
    'Work concretely and verify your claims. When you finish a task, report what you',
    'actually did, what you verified, and anything you deliberately left out.',
  ].join('\n');
}

function normaliseCanMessage(list: string[]): string[] {
  const cleaned = list.map((h) => h.trim()).filter(Boolean);
  if (cleaned.includes('*')) return ['*'];
  return Array.from(new Set(cleaned));
}

/** Duplicate an agent, giving it a fresh id and a free handle. */
export function cloneAgent(
  source: Agent,
  overrides: Partial<CreateAgentInput> & { name?: string } = {},
  existingHandles: string[] = [],
  now = new Date(),
): Agent {
  const name = overrides.name?.trim() || `${source.name} (copy)`;
  const handleBase = overrides.handle ?? `${source.handle}-copy`;
  return {
    ...source,
    id: ids.agent(),
    teamId: overrides.teamId ?? source.teamId,
    handle: uniqueSlug(handleBase, existingHandles),
    name,
    role: overrides.role ?? source.role,
    description: overrides.description ?? source.description,
    systemPrompt: overrides.systemPrompt ?? source.systemPrompt,
    model: overrides.model ?? source.model,
    effort: overrides.effort ? coerceEffort(overrides.effort) : source.effort,
    tools: overrides.tools ?? source.tools.map((t) => ({ ...t })),
    workspace: overrides.workspace ?? source.workspace,
    context: overrides.context ?? source.context,
    // A clone starts with a clean memory: notes are about work already done.
    memory: { enabled: source.memory.enabled, notes: '' },
    communicationRules: overrides.communicationRules ?? source.communicationRules,
    canMessage: normaliseCanMessage(overrides.canMessage ?? source.canMessage),
    limits: { ...source.limits, ...(overrides.limits ?? {}) },
    status: 'idle',
    order: overrides.order ?? existingHandles.length,
    metadata: { ...source.metadata, ...(overrides.metadata ?? {}) },
    createdAt: now,
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------ *
 * Teams
 * ------------------------------------------------------------------ */

export interface CreateTeamInput {
  name: string;
  description?: string;
  workspace?: string;
  budget?: Budget;
  presetId?: string;
  metadata?: Record<string, unknown>;
}

export function createTeam(input: CreateTeamInput, now = new Date()): Team {
  const name = input.name?.trim();
  if (!name) throw invalid('Team name is required');
  return {
    id: ids.team(),
    name,
    description: input.description?.trim() || undefined,
    workspace: input.workspace?.trim() || undefined,
    budget: input.budget,
    presetId: input.presetId,
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

export interface CreateRunInput {
  teamId: string;
  objective: string;
  budget?: Budget;
  workspace?: string;
  agentConfigSnapshot?: Run['agentConfigSnapshot'];
  retryOfRunId?: string;
}

export function createRun(input: CreateRunInput, now = new Date()): Run {
  const objective = input.objective?.trim();
  if (!objective) throw invalid('A run needs an objective');
  if (!input.teamId) throw invalid('A run needs a team');
  return {
    id: ids.run(),
    teamId: input.teamId,
    objective,
    status: 'queued',
    budget: input.budget,
    workspace: input.workspace,
    agentConfigSnapshot: input.agentConfigSnapshot ?? [],
    totals: { usage: emptyUsage(), costUsd: 0, agentActivations: 0, toolCalls: 0, messages: 0 },
    retryOfRunId: input.retryOfRunId,
    createdAt: now,
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

export interface CreateTaskInput {
  runId: string;
  title: string;
  description?: string;
  assignedAgentId?: string;
  dependencies?: string[];
  createdBy: string;
  reviewerAgentId?: string;
  maxAttempts?: number;
  order?: number;
}

export function createTask(input: CreateTaskInput, now = new Date()): Task {
  const title = input.title?.trim();
  if (!title) throw invalid('Task title is required');
  const dependencies = Array.from(new Set((input.dependencies ?? []).filter(Boolean)));
  return {
    id: ids.task(),
    runId: input.runId,
    title,
    description: input.description?.trim() ?? '',
    status: dependencies.length > 0 ? 'pending' : 'ready',
    assignedAgentId: input.assignedAgentId,
    dependencies,
    createdBy: input.createdBy,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 2,
    reviewerAgentId: input.reviewerAgentId,
    order: input.order ?? 0,
    createdAt: now,
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

export interface CreateMessageInput {
  runId: string;
  seq: number;
  from: string;
  to: string[];
  type?: AgentMessageType;
  content: string;
  replyTo?: string;
  correlationId?: string;
  taskId?: string;
  hop?: number;
  path?: string[];
}

export function createMessage(input: CreateMessageInput, now = new Date()): AgentMessage {
  const content = input.content?.trim();
  if (!content) throw invalid('Message content cannot be empty');
  if (!input.to || input.to.length === 0) throw invalid('Message needs at least one recipient');
  return {
    id: ids.message(),
    seq: input.seq,
    runId: input.runId,
    from: input.from,
    to: [...new Set(input.to)],
    type: input.type ?? 'message',
    content,
    status: 'pending',
    replyTo: input.replyTo,
    correlationId: input.correlationId,
    taskId: input.taskId,
    hop: input.hop ?? 0,
    path: input.path ?? [input.from],
    createdAt: now,
  };
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export interface CreateEventInput {
  runId: string;
  seq: number;
  type: RunEventType;
  summary: string;
  agentId?: string;
  taskId?: string;
  messageId?: string;
  data?: Record<string, unknown>;
  model?: string;
  effort?: AgentEffort;
  usage?: RunEvent['usage'];
  costUsd?: number;
  durationMs?: number;
  level?: RunEvent['level'];
}

export function createEvent(input: CreateEventInput, now = new Date()): RunEvent {
  return {
    id: ids.event(),
    seq: input.seq,
    runId: input.runId,
    type: input.type,
    agentId: input.agentId,
    taskId: input.taskId,
    messageId: input.messageId,
    summary: input.summary,
    data: input.data ?? {},
    model: input.model,
    effort: input.effort,
    usage: input.usage,
    costUsd: input.costUsd,
    durationMs: input.durationMs,
    level: input.level ?? 'info',
    createdAt: now,
  };
}

/* ------------------------------------------------------------------ *
 * Approvals
 * ------------------------------------------------------------------ */

export interface CreateApprovalInput {
  runId: string;
  agentId: string;
  category: string;
  toolName: string;
  summary: string;
  input: Record<string, unknown>;
  expiresAt?: Date;
}

export function createApproval(input: CreateApprovalInput, now = new Date()): ApprovalRequest {
  return {
    id: ids.approval(),
    runId: input.runId,
    agentId: input.agentId,
    category: input.category,
    toolName: input.toolName,
    summary: input.summary,
    input: input.input,
    status: 'pending',
    createdAt: now,
    expiresAt: input.expiresAt,
  };
}
