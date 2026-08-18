import type {
  Agent,
  AgentEffort,
  AgentQuestion,
  ApprovalDecision,
  ApprovalRequest,
  LocalSetup,
  RunEvent,
  Team,
} from '@claude-team/domain';
import { ISOLATED_SETUP } from '@claude-team/domain';
import type { AgentProvider } from '@claude-team/provider';
import type { Storage } from '@claude-team/persistence';

/** Everything the engine needs, injected rather than constructed. */
export interface RuntimeDeps {
  storage: Storage;
  provider: AgentProvider;
  /** Called for every recorded event, after it has been persisted. */
  onEvent?: (event: RunEvent) => void;
  /** Called whenever an agent's status changes, for cheap UI updates. */
  onAgentStatus?: (agentId: string, status: Agent['status']) => void;
  /** Called when a run's status changes. */
  onRunStatus?: (runId: string, status: string) => void;
  /** Called when an approval is created or resolved. */
  onApproval?: (approval: ApprovalRequest) => void;
  /** Called when a question to the human is raised or answered. */
  onQuestion?: (question: AgentQuestion) => void;
  clock?: () => Date;
}

export interface RunEngineOptions {
  /** How many agents may be active at the same time within one run. */
  maxConcurrentAgents: number;
  /** Hard ceiling on orchestrator rounds; a runaway-loop backstop. */
  maxRounds: number;
  /** How long a synchronous `ask_agent` waits for an answer. */
  askTimeoutMs: number;
  /** How long an approval request waits for a human before being denied. */
  approvalTimeoutMs: number;
  /** Routing guards. */
  maxHops: number;
  maxRecursionDepth: number;
  maxMessagesPerRun: number;
  /** Skip every approval prompt (dangerous; opt-in through Settings). */
  autoApproveAll: boolean;
  /** Answer an agent's question automatically instead of waiting for a human. */
  autoAnswerQuestions: boolean;
  /** How long a question waits for a human before it is auto-answered. */
  questionTimeoutMs: number;
  /** Categories that always need a human, even when the capability says allow. */
  requireApprovalFor: string[];
  /**
   * How much of the machine's Claude Code installation agents inherit. Handed
   * to the provider on every activation, so it is a property of the run rather
   * than of the process.
   */
  localSetup: LocalSetup;
}

export const DEFAULT_ENGINE_OPTIONS: RunEngineOptions = {
  maxConcurrentAgents: 3,
  maxRounds: 15,
  askTimeoutMs: 5 * 60 * 1000,
  approvalTimeoutMs: 10 * 60 * 1000,
  maxHops: 8,
  maxRecursionDepth: 4,
  maxMessagesPerRun: 500,
  autoApproveAll: false,
  autoAnswerQuestions: false,
  questionTimeoutMs: 30 * 60 * 1000,
  requireApprovalFor: ['shell', 'destructive', 'git'],
  localSetup: ISOLATED_SETUP,
};

/** Resolved context for a single run, loaded once at start. */
export interface RunContext {
  team: Team;
  agents: Agent[];
  orchestrator: Agent;
  workspace?: string;
}

export interface ActivationResult {
  ok: boolean;
  text: string;
  error?: string;
  model: string;
  effort: AgentEffort;
  durationMs: number;
  costUsd?: number;
}

export type ApprovalResolver = (id: string, decision: ApprovalDecision, decidedBy?: string) => boolean;
