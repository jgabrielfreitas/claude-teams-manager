import type {
  Agent,
  AgentMessage,
  AppSettings,
  ApprovalRequest,
  Run,
  RunEvent,
  RunStatus,
  Task,
  Team,
} from '@claude-team/domain';

/**
 * Storage contract.
 *
 * The application core depends only on this interface, never on SQLite. That
 * is what lets the test suite run the entire runtime against an in-memory
 * implementation, and what would let a future build talk to a remote server
 * without touching a single use case (ADR-005).
 *
 * Every method is async even though the SQLite implementation is synchronous:
 * the cost is negligible and it keeps the seam honest.
 */

export interface ListOptions {
  limit?: number;
  offset?: number;
}

export interface TeamRepository {
  list(): Promise<Team[]>;
  get(id: string): Promise<Team | undefined>;
  findByName(name: string): Promise<Team | undefined>;
  create(team: Team): Promise<Team>;
  update(team: Team): Promise<Team>;
  delete(id: string): Promise<void>;
}

export interface AgentRepository {
  listAll(): Promise<Agent[]>;
  listByTeam(teamId: string): Promise<Agent[]>;
  get(id: string): Promise<Agent | undefined>;
  getByHandle(teamId: string, handle: string): Promise<Agent | undefined>;
  create(agent: Agent): Promise<Agent>;
  update(agent: Agent): Promise<Agent>;
  delete(id: string): Promise<void>;
  /** Bulk status reset, used when the process restarts mid-run. */
  resetStatuses(): Promise<void>;
}

export interface RunListFilter extends ListOptions {
  teamId?: string;
  status?: RunStatus[];
}

export interface RunRepository {
  list(filter?: RunListFilter): Promise<Run[]>;
  get(id: string): Promise<Run | undefined>;
  create(run: Run): Promise<Run>;
  update(run: Run): Promise<Run>;
  delete(id: string): Promise<void>;
  /** Runs left in a non-terminal state by a previous process. */
  listInterrupted(): Promise<Run[]>;
}

export interface TaskRepository {
  listByRun(runId: string): Promise<Task[]>;
  get(id: string): Promise<Task | undefined>;
  create(task: Task): Promise<Task>;
  createMany(tasks: Task[]): Promise<Task[]>;
  update(task: Task): Promise<Task>;
  updateMany(tasks: Task[]): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface MessageListFilter extends ListOptions {
  runId?: string;
  /** Messages where this participant is a recipient. */
  toParticipant?: string;
  /** Messages sent by this participant. */
  fromParticipant?: string;
  /** Only messages with `seq` greater than this. */
  afterSeq?: number;
}

export interface MessageRepository {
  list(filter?: MessageListFilter): Promise<AgentMessage[]>;
  get(id: string): Promise<AgentMessage | undefined>;
  create(message: AgentMessage): Promise<AgentMessage>;
  update(message: AgentMessage): Promise<AgentMessage>;
  countByRun(runId: string): Promise<number>;
  /** Allocates the next per-run message sequence number atomically. */
  nextSeq(runId: string): Promise<number>;
}

export interface EventListFilter extends ListOptions {
  runId?: string;
  afterSeq?: number;
  types?: string[];
  agentId?: string;
}

export interface EventRepository {
  list(filter?: EventListFilter): Promise<RunEvent[]>;
  append(event: RunEvent): Promise<RunEvent>;
  countByRun(runId: string): Promise<number>;
  nextSeq(runId: string): Promise<number>;
  /** Most recent events across all runs, for the Activity view. */
  recent(limit: number): Promise<RunEvent[]>;
}

export interface ApprovalRepository {
  list(filter?: { runId?: string; status?: string }): Promise<ApprovalRequest[]>;
  get(id: string): Promise<ApprovalRequest | undefined>;
  create(approval: ApprovalRequest): Promise<ApprovalRequest>;
  update(approval: ApprovalRequest): Promise<ApprovalRequest>;
}

export interface SettingsRepository {
  get(): Promise<AppSettings>;
  save(settings: AppSettings): Promise<AppSettings>;
}

export interface Storage {
  readonly teams: TeamRepository;
  readonly agents: AgentRepository;
  readonly runs: RunRepository;
  readonly tasks: TaskRepository;
  readonly messages: MessageRepository;
  readonly events: EventRepository;
  readonly approvals: ApprovalRepository;
  readonly settings: SettingsRepository;

  /** Applies migrations and prepares the store. Safe to call more than once. */
  init(): Promise<void>;
  close(): Promise<void>;

  /** Human-readable location of the store, shown in Settings. */
  describe(): { driver: string; location: string };
}
