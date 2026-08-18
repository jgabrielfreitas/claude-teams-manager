import type {
  Agent,
  AgentEffort,
  AgentMessage,
  AgentQuestion,
  AgentStatus,
  AppSettings,
  ApprovalRequest,
  ModelDefinition,
  Run,
  RunEvent,
  RunStatus,
  Task,
  Team,
  TeamWithAgents,
  ToolGroupDescriptor,
} from '@claude-team/domain';

/**
 * Wire shapes.
 *
 * Dates cross the wire as ISO strings, so the client re-hydrates them once, in
 * one place, instead of every component guessing. Everything else is the
 * domain type verbatim — there is no parallel "API model" to keep in sync.
 */

export type Jsonified<T> = T extends Date
  ? string
  : T extends Array<infer U>
    ? Array<Jsonified<U>>
    : T extends object
      ? { [K in keyof T]: Jsonified<T[K]> }
      : T;

export type TeamDto = Jsonified<Team>;
export type TeamWithAgentsDto = Jsonified<TeamWithAgents>;
export type AgentDto = Jsonified<Agent>;
export type RunDto = Jsonified<Run>;
export type TaskDto = Jsonified<Task>;
export type MessageDto = Jsonified<AgentMessage>;
export type RunEventDto = Jsonified<RunEvent>;
export type ApprovalDto = Jsonified<ApprovalRequest>;
export type QuestionDto = Jsonified<AgentQuestion>;
export type SettingsDto = Jsonified<AppSettings>;

export interface CatalogDto {
  models: ModelDefinition[];
  efforts: Array<{ id: AgentEffort; label: string; description: string; rank: number }>;
  toolGroups: ToolGroupDescriptor[];
  templates: Array<{
    id: string;
    name: string;
    role: string;
    description: string;
    model: string;
    effort: AgentEffort;
    category: string;
    handle: string;
    orchestratorCapable?: boolean;
  }>;
  /**
   * Presets with every member already resolved to the handle, model and effort
   * the core will actually create — so a preview cannot promise otherwise.
   */
  presets: Array<{
    id: string;
    name: string;
    description: string;
    members: Array<{
      templateId: string;
      handle: string;
      name: string;
      role: string;
      description: string;
      model: string;
      effort: AgentEffort;
      canMessage: string[];
      orchestrator: boolean;
    }>;
  }>;
  providers: Array<{ id: string; label: string; current: boolean }>;
}

export interface TaskProgressDto {
  total: number;
  completed: number;
  failed: number;
  running: number;
  blocked: number;
  pending: number;
  percent: number;
}

export interface DashboardDto {
  teams: Array<TeamWithAgentsDto & { activeRunId?: string }>;
  activeRuns: RunDto[];
  recentRuns: RunDto[];
  recentEvents: RunEventDto[];
  pendingApprovals: ApprovalDto[];
  pendingQuestions: QuestionDto[];
  /** Task progress per active run, keyed by run id. */
  progress: Record<string, TaskProgressDto>;
  counts: { teams: number; agents: number; runs: number; runningAgents: number };
  settings: SettingsDto;
}

export interface RunDetailDto {
  run: RunDto;
  team: TeamDto;
  agents: AgentDto[];
  tasks: TaskDto[];
  messages: MessageDto[];
  events: RunEventDto[];
  approvals: ApprovalDto[];
  questions: QuestionDto[];
  progress: TaskProgressDto;
  isActive: boolean;
}

export interface AgentInspectionDto {
  agent: AgentDto;
  team: TeamDto;
  currentTask?: TaskDto;
  messageCount: number;
  unreadCount: number;
  toolCalls: number;
  runtimeMs: number;
  activations: number;
  lastEvents: RunEventDto[];
  inbox: MessageDto[];
  reachable: string[];
}

export interface SearchHitDto {
  kind: 'team' | 'agent' | 'run' | 'task' | 'message';
  id: string;
  title: string;
  subtitle: string;
  score: number;
  teamId?: string;
  runId?: string;
  agentId?: string;
}

export interface OnboardingStatusDto {
  needed: boolean;
  settings: SettingsDto;
}

export interface EnvironmentDto {
  claude: {
    cliInstalled: boolean;
    cliPath?: string;
    cliVersion?: string;
    authenticated: boolean;
    authMethod: 'api_key' | 'subscription' | 'none';
    mcpServers: Array<{ name: string; scope: string; transport: string }>;
    skills: Array<{ name: string; scope: string; description?: string }>;
    availableTools: string[];
    sdkInstalled: boolean;
  };
  workspace: WorkspaceDto;
  storage: { driver: string; location: string };
  existingTeams: number;
}

export interface WorkspaceDto {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  git: {
    isRepo: boolean;
    branch?: string;
    dirtyFiles: number;
    lastCommit?: string;
    remote?: string;
    ahead?: number;
    behind?: number;
    isWorktree?: boolean;
  };
  summary?: string;
}

export interface ProviderHealthDto {
  ok: boolean;
  detail: string;
  authenticated?: boolean;
  authSource?: string;
  version?: string;
}

/* ------------------------------------------------------------------ *
 * Realtime
 * ------------------------------------------------------------------ */

/**
 * The wire form of the core's `AppEvent`, delivered over SSE.
 *
 * The browser cannot import `@claude-team/core` (it is Node-only), so the union
 * lives here — and `packages/core` asserts at compile time that its own
 * `AppEvent` still serialises to exactly this shape. Adding a variant in the
 * core without adding it here is a build error rather than a silent gap
 * between the two surfaces.
 */
export type AppEventDto =
  | { type: 'run.event'; runId: string; event: RunEventDto }
  | { type: 'run.status'; runId: string; status: RunStatus; run?: RunDto }
  | { type: 'run.created'; run: RunDto }
  | { type: 'run.deleted'; runId: string }
  | { type: 'agent.status'; agentId: string; status: AgentStatus }
  | { type: 'message'; message: MessageDto }
  | { type: 'approval'; approval: ApprovalDto }
  | { type: 'question'; question: QuestionDto }
  | { type: 'task.changed'; runId: string; task: TaskDto }
  | { type: 'team.changed'; teamId: string | null }
  | { type: 'agent.changed'; agentId: string | null; teamId: string }
  | { type: 'settings.changed' }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string };

/** Is this event relevant to the run currently on screen? */
export function eventTouchesRun(event: AppEventDto, runId: string): boolean {
  switch (event.type) {
    case 'run.event':
    case 'run.status':
    case 'task.changed':
    case 'run.deleted':
      return event.runId === runId;
    case 'run.created':
      return event.run.id === runId;
    case 'message':
      return event.message.runId === runId;
    case 'approval':
      return event.approval.runId === runId;
    case 'question':
      return event.question.runId === runId;
    default:
      return false;
  }
}

/** Is this event relevant to the agent currently on screen? */
export function eventTouchesAgent(event: AppEventDto, agentId: string): boolean {
  switch (event.type) {
    case 'agent.status':
      return event.agentId === agentId;
    case 'agent.changed':
      return event.agentId === agentId || event.agentId === null;
    case 'run.event':
      return event.event.agentId === agentId;
    case 'message':
      return event.message.from === agentId || event.message.to.includes(agentId);
    case 'approval':
      return event.approval.agentId === agentId;
    case 'question':
      return event.question.agentId === agentId;
    default:
      return false;
  }
}

/** Is this event relevant to the team currently on screen? */
export function eventTouchesTeam(event: AppEventDto, teamId: string): boolean {
  switch (event.type) {
    case 'team.changed':
      return event.teamId === teamId || event.teamId === null;
    case 'agent.changed':
      return event.teamId === teamId;
    case 'run.created':
      return event.run.teamId === teamId;
    default:
      return false;
  }
}

/** Recursively converts ISO date strings back into `Date` objects. */
const DATE_KEYS = new Set([
  'createdAt',
  'updatedAt',
  'startedAt',
  'completedAt',
  'readAt',
  'resolvedAt',
  'expiresAt',
  'decidedAt',
]);

export function reviveDates<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reviveDates) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = DATE_KEYS.has(key) && typeof v === 'string' ? new Date(v) : reviveDates(v);
    }
    return out as T;
  }
  return value;
}
