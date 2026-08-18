import type {
  AgentEffort,
  DomainError,
  LocalSetup,
  ModelDefinition,
  TokenUsage,
  ToolPermission,
} from '@claude-team/domain';

/**
 * Provider abstraction (ADR-004).
 *
 * The runtime knows only this file. Nothing about the Claude Agent SDK — its
 * option names, its message union, its permission callback shape — is allowed
 * to appear above this seam.
 */

/** A tool the host process implements and exposes to the agent in-process. */
export interface ProviderToolSpec {
  name: string;
  description: string;
  /**
   * A zod *raw shape* (`{ field: z.string() }`), not a `z.object(...)`.
   * The provider wraps it for whatever the underlying SDK expects.
   */
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, any>) => Promise<ProviderToolResult>;
}

export interface ProviderToolResult {
  text: string;
  isError?: boolean;
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/** Everything the provider needs to execute one agent activation. */
export interface AgentRunInput {
  /** Correlates this activation with the run it belongs to. */
  runId: string;
  /** Unique id for this single activation; used by `cancel`. */
  activationId: string;

  agentId: string;
  agentHandle: string;

  /** Fully-resolved system prompt: persona, context, memory, roster, rules. */
  systemPrompt: string;
  /** The actual instruction for this activation. */
  prompt: string;

  /** Per-agent model. Never inherited from the team or the orchestrator. */
  model: string;
  /** Per-agent reasoning effort. Never inherited. */
  effort: AgentEffort;

  /** Capability grants, translated by the provider into concrete tool grants. */
  tools: ToolPermission[];
  /** Host-implemented tools (agent messaging, task management, memory). */
  customTools: ProviderToolSpec[];

  cwd?: string;
  maxTurns?: number;
  timeoutMs?: number;

  /** Provider session to continue, so an agent keeps its context across turns. */
  sessionId?: string;

  /** Consulted for every capability whose mode is `ask`. */
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>;

  signal?: AbortSignal;

  /** Extra environment for the provider process, e.g. a scoped API key. */
  env?: Record<string, string>;

  /**
   * How much of the machine's own Claude Code installation this activation
   * inherits — settings, memory, skills, MCP servers. Absent means isolated.
   * Passed per activation rather than fixed when the provider is constructed,
   * so changing it in Settings takes effect on the next run instead of on the
   * next restart.
   */
  localSetup?: LocalSetup;
}

export interface PermissionRequest {
  runId: string;
  agentId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Capability group this tool belongs to, as resolved by the provider. */
  group?: string;
  /** Human-readable one-liner describing exactly what will happen. */
  summary: string;
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export type AgentEvent =
  | { type: 'started'; sessionId?: string; model: string; effort: AgentEffort; availableTools?: string[] }
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      toolCallId: string;
      toolName: string;
      isError: boolean;
      summary: string;
    }
  | { type: 'permission_denied'; toolName: string; reason: string }
  | {
      type: 'completed';
      result: string;
      sessionId?: string;
      usage: TokenUsage;
      costUsd?: number;
      numTurns: number;
      durationMs: number;
    }
  /**
   * A failed or cancelled activation still costs money. `usage`/`costUsd` carry
   * whatever was spent before it ended, so a cancelled run does not report as
   * free — the provider only reports authoritative totals on success, and a run
   * the human stopped would otherwise show zero.
   */
  | {
      type: 'error';
      error: DomainError;
      recoverable: boolean;
      usage?: TokenUsage;
      costUsd?: number;
    };

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

export interface ProviderHealth {
  ok: boolean;
  /** Short reason when `ok` is false, ready to show in the UI. */
  detail: string;
  authenticated?: boolean;
  authSource?: string;
  version?: string;
}

export interface AgentProvider {
  readonly id: string;
  readonly label: string;

  run(input: AgentRunInput): AsyncIterable<AgentEvent>;

  /** Aborts an in-flight activation. Resolves even if it already finished. */
  cancel(activationId: string): Promise<void>;

  getModels(): Promise<ModelDefinition[]>;

  healthCheck(): Promise<ProviderHealth>;
}
