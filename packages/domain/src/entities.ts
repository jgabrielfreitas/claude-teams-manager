import type { AgentEffort } from './effort.js';
import type { ToolPermission } from './permissions.js';
import type { TokenUsage } from './models.js';

/* ------------------------------------------------------------------ *
 * Agent
 * ------------------------------------------------------------------ */

export const AGENT_STATUSES = [
  'idle',
  'queued',
  'thinking',
  'working',
  'waiting',
  'blocked',
  'paused',
  'failed',
  'completed',
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Execution limits enforced by the runtime for a single agent. */
export interface AgentLimits {
  /** Max provider turns per task execution. */
  maxTurns?: number;
  /** Wall-clock timeout for a single agent activation, in milliseconds. */
  timeoutMs?: number;
  /** Max inbound messages this agent will process during one run. */
  maxMessages?: number;
}

/** Long-lived notes an agent carries between runs. */
export interface AgentMemory {
  enabled: boolean;
  /** Free-form markdown, appended to by the agent through the `remember` tool. */
  notes: string;
}

export interface Agent {
  id: string;
  teamId: string;

  /** Stable, human-typeable handle, unique within the team (`architect`). */
  handle: string;
  name: string;
  role: string;
  description?: string;

  systemPrompt: string;

  /** Opaque provider model id. Always per-agent — never inherited at run time. */
  model: string;
  /** Per-agent reasoning effort. Always per-agent — never inherited at run time. */
  effort: AgentEffort;

  tools: ToolPermission[];

  /** Overrides the team workspace when set. */
  workspace?: string;

  /** Static extra context injected into every activation. */
  context: string;
  memory: AgentMemory;

  /** Free-form rules about how this agent should communicate with teammates. */
  communicationRules: string;
  /** Handles of teammates this agent may message. `['*']` means everyone. */
  canMessage: string[];

  limits: AgentLimits;

  status: AgentStatus;

  /** Display order inside the team. */
  order: number;

  /** Template this agent was created from, when applicable. */
  templateId?: string;

  metadata: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}

/* ------------------------------------------------------------------ *
 * Team
 * ------------------------------------------------------------------ */

/** Optional spend guardrails applied to every run of a team (overridable per run). */
export interface Budget {
  maxTokens?: number;
  maxCostUsd?: number;
  maxDurationMinutes?: number;
  /** Hard cap on agent activations, a cheap circuit breaker. */
  maxAgentActivations?: number;
}

export interface Team {
  id: string;
  name: string;
  description?: string;

  /** Agent id of the orchestrator for this team. */
  orchestratorId?: string;
  /** Agent id used when the user talks to "the team" without picking someone. */
  defaultAgentId?: string;

  workspace?: string;

  budget?: Budget;

  /** Preset this team was created from, when applicable. */
  presetId?: string;

  metadata: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}

/** Aggregate shape returned by the application core for convenience. */
export interface TeamWithAgents extends Team {
  agents: Agent[];
}

/* ------------------------------------------------------------------ *
 * Task
 * ------------------------------------------------------------------ */

export const TASK_STATUSES = [
  'pending',
  'ready',
  'running',
  'blocked',
  'review',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: string;
  runId: string;

  title: string;
  description: string;

  status: TaskStatus;

  /** Agent id the task is assigned to. */
  assignedAgentId?: string;

  /** Task ids that must reach `completed` before this becomes `ready`. */
  dependencies: string[];

  /** Agent id (or `user`) that created this task. */
  createdBy: string;

  result?: string;
  error?: string;

  attempts: number;
  maxAttempts: number;

  /** Optional agent id that must review the result before completion. */
  reviewerAgentId?: string;

  order: number;

  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export const TERMINAL_TASK_STATUSES: TaskStatus[] = ['completed', 'failed', 'cancelled'];

export function isTaskTerminal(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

export const RUN_STATUSES = [
  'queued',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunTotals {
  usage: TokenUsage;
  costUsd: number;
  agentActivations: number;
  toolCalls: number;
  messages: number;
}

export interface Run {
  id: string;
  teamId: string;

  objective: string;

  status: RunStatus;

  /** Effective budget for this run (team budget unless overridden at start). */
  budget?: Budget;

  workspace?: string;

  /** Snapshot of every agent's model/effort at the moment the run started. */
  agentConfigSnapshot: AgentConfigSnapshot[];

  totals: RunTotals;

  summary?: string;
  error?: string;

  /** Run id this run was retried from, when applicable. */
  retryOfRunId?: string;

  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  updatedAt: Date;
}

/** Exactly which configuration each agent ran with — required for replay/audit. */
export interface AgentConfigSnapshot {
  agentId: string;
  handle: string;
  name: string;
  role: string;
  model: string;
  effort: AgentEffort;
  isOrchestrator: boolean;
}

export const TERMINAL_RUN_STATUSES: RunStatus[] = ['completed', 'failed', 'cancelled'];

export function isRunTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/* ------------------------------------------------------------------ *
 * Agent-to-agent messages
 * ------------------------------------------------------------------ */

export const MESSAGE_TYPES = [
  'message',
  'question',
  'answer',
  'request',
  'result',
  'handoff',
] as const;

export type AgentMessageType = (typeof MESSAGE_TYPES)[number];

export const MESSAGE_STATUSES = [
  'pending',
  'read',
  'processing',
  'completed',
  'failed',
] as const;

export type AgentMessageStatus = (typeof MESSAGE_STATUSES)[number];

export interface AgentMessage {
  id: string;
  /** Monotonic per-run sequence number, used as the human-visible `#123`. */
  seq: number;

  runId: string;

  /** Agent id, or the literal `user`. */
  from: string;
  /** Agent ids, or the literal `user`. */
  to: string[];

  type: AgentMessageType;
  content: string;

  status: AgentMessageStatus;

  /** Message this one answers, for synchronous ask/answer pairing. */
  replyTo?: string;
  /** Correlation id shared by an ask and its answer. */
  correlationId?: string;

  /** Task this message is about, when applicable. */
  taskId?: string;

  /** How many agent-to-agent hops produced this message. Guards against loops. */
  hop: number;
  /** Chain of agent ids this message descends from, for cycle detection. */
  path: string[];

  error?: string;

  createdAt: Date;
  readAt?: Date;
  completedAt?: Date;
}

export const USER_PARTICIPANT = 'user';

/* ------------------------------------------------------------------ *
 * Timeline events
 * ------------------------------------------------------------------ */

export const RUN_EVENT_TYPES = [
  'run_created',
  'run_started',
  'run_paused',
  'run_resumed',
  'run_completed',
  'run_failed',
  'run_cancelled',
  'agent_started',
  'agent_stopped',
  'agent_status_changed',
  'agent_thinking',
  'agent_output',
  'task_created',
  'task_assigned',
  'task_started',
  'task_completed',
  'task_failed',
  'task_blocked',
  'task_review_requested',
  'message_sent',
  'message_received',
  'tool_call',
  'tool_result',
  'approval_requested',
  'approval_resolved',
  'question_asked',
  'question_answered',
  'budget_warning',
  'budget_exceeded',
  'error',
  'log',
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export interface RunEvent {
  id: string;
  seq: number;
  runId: string;
  type: RunEventType;

  agentId?: string;
  taskId?: string;
  messageId?: string;

  /** One-line human-readable summary, ready to render in a timeline. */
  summary: string;

  /** Structured payload; shape depends on `type`. */
  data: Record<string, unknown>;

  /** Configuration in force when the event happened. */
  model?: string;
  effort?: AgentEffort;

  usage?: TokenUsage;
  costUsd?: number;
  durationMs?: number;

  level: 'debug' | 'info' | 'warn' | 'error';

  createdAt: Date;
}

/* ------------------------------------------------------------------ *
 * Human-in-the-loop approvals
 * ------------------------------------------------------------------ */

export const APPROVAL_DECISIONS = ['allow_once', 'allow_always', 'deny'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const APPROVAL_STATUSES = ['pending', 'resolved', 'expired'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface ApprovalRequest {
  id: string;
  runId: string;
  agentId: string;

  category: string;
  toolName: string;
  /** Short description of exactly what will happen if approved. */
  summary: string;
  input: Record<string, unknown>;

  status: ApprovalStatus;
  decision?: ApprovalDecision;
  decidedBy?: string;

  createdAt: Date;
  resolvedAt?: Date;
  expiresAt?: Date;
}

/* ------------------------------------------------------------------ *
 * Questions to the human
 * ------------------------------------------------------------------ */

export const QUESTION_STATUSES = ['pending', 'answered', 'expired', 'skipped'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export interface QuestionOption {
  label: string;
  /** What choosing this means, shown under the label. */
  description?: string;
}

/**
 * An agent asking the *human* something it cannot decide alone.
 *
 * Deliberately distinct from `ApprovalRequest`: an approval answers "may I do
 * this?" with yes/no, while a question answers "which of these?" or "what
 * should it be?" and returns content the agent then works from. Routing one
 * through the other — which is what happens when a provider's built-in
 * ask-the-user tool is mistaken for an unknown capability — grants permission
 * without ever delivering an answer, and the agent stalls.
 */
export interface AgentQuestion {
  id: string;
  runId: string;
  agentId: string;

  /** Short label for the decision, e.g. "Niche". */
  header?: string;
  question: string;
  options: QuestionOption[];
  /** The human may pick more than one option. */
  allowMultiple: boolean;
  /** The human may type an answer instead of picking. */
  allowFreeform: boolean;

  /** Task the agent was working on when it asked, when applicable. */
  taskId?: string;

  status: QuestionStatus;
  /** What was sent back to the agent. */
  answer?: string;
  answeredBy?: string;

  createdAt: Date;
  answeredAt?: Date;
  expiresAt?: Date;
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export interface AppSettings {
  /** Marks onboarding as done so the wizard does not run again. */
  onboardingCompleted: boolean;
  /** Default workspace suggested for new teams. */
  defaultWorkspace?: string;
  /**
   * Where the YAML mirror of every team is written. Unset means "next to the
   * database", i.e. `<claude-team home>/teams`.
   */
  teamsDir?: string;
  defaultModel: string;
  defaultOrchestratorModel: string;
  defaultEffort: AgentEffort;
  /** Provider id used to execute agents. */
  provider: string;
  /** Global run guardrails, used when a team defines none. */
  defaultBudget: Budget;
  /** Approval categories that always require a human decision. */
  requireApprovalFor: string[];
  /** When true, no approval prompts are raised (dangerous, opt-in). */
  autoApproveAll: boolean;
  /**
   * When true, an agent's question to the human is answered automatically with
   * an instruction to decide and state the assumption, instead of blocking.
   * Together with `autoApproveAll` this is what the UIs call "auto mode".
   */
  autoAnswerQuestions: boolean;
  /** How long a question waits for a human before it is auto-answered. */
  questionTimeoutMs: number;
  /** Max agent-to-agent hops before the bus refuses to deliver. */
  maxHops: number;
  /** Max depth of nested synchronous asks. */
  maxRecursionDepth: number;
  /** Timeout for a synchronous agent-to-agent ask, in milliseconds. */
  askTimeoutMs: number;
  /** Web server port. */
  webPort: number;
  theme: 'auto' | 'dark' | 'light';
  telemetry: boolean;
  updatedAt: Date;
}
