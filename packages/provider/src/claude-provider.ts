import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  BUILTIN_CLAUDE_MODELS,
  DomainError,
  emptyUsage,
  estimateCostUsd,
  toDomainError,
  type ModelDefinition,
  type TokenUsage,
} from '@claude-team/domain';
import { toClaudeEffort } from './effort-adapter.js';
import {
  approvalCategoryFor,
  describeToolCall,
  groupForTool,
  isGitCommand,
  resolveToolGrants,
} from './tool-mapping.js';
import type {
  AgentEvent,
  AgentProvider,
  AgentRunInput,
  PermissionDecision,
  ProviderHealth,
  ProviderToolSpec,
} from './types.js';

/**
 * The Claude implementation of `AgentProvider`, built on the official
 * TypeScript Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).
 *
 * We use the SDK rather than parsing CLI output: it gives us a typed message
 * stream, a real permission callback, in-process MCP tools, per-query model and
 * effort selection, interruption, and token/cost accounting — all of which we
 * would otherwise have to reconstruct from terminal text (ADR-004).
 */

/** Name of the in-process MCP server that carries our host-implemented tools. */
export const TEAM_TOOL_SERVER = 'team';

/**
 * The SDK warns when a tool appears in `allowedTools` *and* a `canUseTool`
 * callback is installed, because the bare entry auto-approves before the
 * callback runs. For us that is the whole point: `allow` capabilities are
 * supposed to run without a prompt, and only `ask` capabilities are left out of
 * `allowedTools` so they fall through to the approval gate. The warning is
 * therefore expected on every activation, and it would otherwise scribble over
 * the TUI, so we filter this one code out.
 */
let warningFilterInstalled = false;
function suppressExpectedShadowWarning(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const code =
      typeof rest[0] === 'string'
        ? rest[0]
        : ((rest[0] as { code?: string } | undefined)?.code ?? '');
    const text = typeof warning === 'string' ? warning : warning.message;
    if (code === 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' || text.includes('CLAUDE_SDK_CAN_USE_TOOL_SHADOWED')) {
      return;
    }
    return (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

interface Activation {
  abort: AbortController;
  interrupt?: () => Promise<unknown>;
}

export interface ClaudeProviderOptions {
  /** Override the `claude` executable the SDK spawns. */
  pathToClaudeCodeExecutable?: string;
  /**
   * Which of the user's own Claude Code setting files to load. Defaults to
   * none, so a team behaves identically on every machine.
   */
  settingSources?: Array<'user' | 'project' | 'local'>;
  /** Extra MCP servers made available to every agent. */
  mcpServers?: Record<string, unknown>;
}

export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude';
  readonly label = 'Claude (Agent SDK)';

  private readonly activations = new Map<string, Activation>();
  private modelCache?: ModelDefinition[];

  constructor(private readonly options: ClaudeProviderOptions = {}) {
    suppressExpectedShadowWarning();
  }

  async cancel(activationId: string): Promise<void> {
    const activation = this.activations.get(activationId);
    if (!activation) return;
    try {
      await activation.interrupt?.();
    } catch {
      // The query may already be finished; aborting below is enough.
    }
    activation.abort.abort();
    this.activations.delete(activationId);
  }

  async getModels(): Promise<ModelDefinition[]> {
    if (this.modelCache) return this.modelCache;
    try {
      const discovered = await this.discoverModels();
      if (discovered.length > 0) {
        this.modelCache = discovered;
        return discovered;
      }
    } catch {
      // Discovery is best effort; the built-in catalog is a fine fallback.
    }
    this.modelCache = BUILTIN_CLAUDE_MODELS;
    return BUILTIN_CLAUDE_MODELS;
  }

  /**
   * Asks a live session which models this account can actually use. Falls back
   * to the built-in catalog when the SDK build predates `supportedModels()`.
   */
  private async discoverModels(): Promise<ModelDefinition[]> {
    const abort = new AbortController();
    // A prompt stream that never produces a message: we only want the session's
    // control channel in order to ask it which models are available, not a
    // completion. The session is aborted in `finally`.
    const idlePrompt: AsyncIterable<never> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => {}) }),
    };
    const q = query({
      prompt: idlePrompt as never,
      options: { abortController: abort, settingSources: [] } as never,
    });

    try {
      const anyQuery = q as unknown as { supportedModels?: () => Promise<RawModelInfo[]> };
      if (typeof anyQuery.supportedModels !== 'function') return [];
      const raw = await withTimeout(anyQuery.supportedModels(), 15_000);
      return raw.map((m) => ({
        id: m.value,
        label: m.displayName || m.value,
        provider: 'claude',
        description: m.description,
        resolvedModel: m.resolvedModel,
        supportsEffort: m.supportsEffort,
        pricing: BUILTIN_CLAUDE_MODELS.find(
          (b) => b.id === m.value || b.id === m.resolvedModel,
        )?.pricing,
      }));
    } finally {
      abort.abort();
      try {
        await q.return(undefined as never);
      } catch {
        /* the generator is already done */
      }
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30_000);
    try {
      const q = query({
        prompt: 'Reply with the single word: ok',
        options: {
          model: 'haiku',
          maxTurns: 1,
          allowedTools: [],
          disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch'],
          systemPrompt: 'Reply with the single word "ok". Nothing else.',
          settingSources: this.options.settingSources ?? [],
          abortController: abort,
          ...(this.options.pathToClaudeCodeExecutable
            ? { pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable }
            : {}),
        } as never,
      });

      let authSource: string | undefined;
      let version: string | undefined;

      for await (const message of q) {
        const m = message as RawMessage;
        if (m.type === 'system' && m.subtype === 'init') {
          authSource = m.apiKeySource;
          version = m.claude_code_version;
        }
        if (m.type === 'result') {
          if (m.subtype !== 'success') {
            return {
              ok: false,
              detail: String(m.error ?? m.result ?? 'The provider returned an error.'),
              authenticated: false,
              authSource,
              version,
            };
          }
          return {
            ok: true,
            detail: 'Claude responded successfully.',
            authenticated: true,
            authSource,
            version,
          };
        }
      }
      return { ok: false, detail: 'The provider stream ended without a result.', version };
    } catch (err) {
      return { ok: false, detail: describeError(err), authenticated: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const abort = new AbortController();
    const activation: Activation = { abort };
    this.activations.set(input.activationId, activation);

    // Chain the caller's signal so a run-level cancel aborts every agent.
    const onExternalAbort = () => abort.abort();
    input.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const timeout = input.timeoutMs
      ? setTimeout(() => abort.abort(), input.timeoutMs)
      : undefined;

    const startedAt = Date.now();
    let sessionId = input.sessionId;
    let usage: TokenUsage = emptyUsage();
    let costUsd: number | undefined;
    let numTurns = 0;
    let lastText = '';
    let sawResult = false;

    try {
      const grants = resolveToolGrants(
        input.tools,
        input.customTools.map((t) => qualifiedToolName(t.name)),
      );

      const mcpServers: Record<string, unknown> = { ...(this.options.mcpServers ?? {}) };
      if (input.customTools.length > 0) {
        mcpServers[TEAM_TOOL_SERVER] = buildTeamToolServer(input.customTools);
      }

      const q = query({
        prompt: input.prompt,
        options: {
          model: input.model,
          effort: toClaudeEffort(input.effort),
          systemPrompt: input.systemPrompt,
          cwd: input.cwd,
          maxTurns: input.maxTurns,
          allowedTools: grants.allowedTools,
          disallowedTools: grants.disallowedTools,
          permissionMode: 'default',
          canUseTool: this.buildPermissionCallback(input, grants.askTools),
          mcpServers,
          // Deliberately isolated from the user's own Claude Code configuration
          // so a team behaves the same on every machine.
          settingSources: this.options.settingSources ?? [],
          abortController: abort,
          ...(input.sessionId ? { resume: input.sessionId } : {}),
          ...(input.env ? { env: { ...process.env, ...input.env } } : {}),
          ...(this.options.pathToClaudeCodeExecutable
            ? { pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable }
            : {}),
        } as never,
      });

      activation.interrupt = () => q.interrupt();

      for await (const message of q) {
        const m = message as RawMessage;

        if (m.type === 'system' && m.subtype === 'init') {
          sessionId = m.session_id ?? sessionId;
          yield {
            type: 'started',
            sessionId,
            model: input.model,
            effort: input.effort,
            availableTools: m.tools,
          };
          continue;
        }

        if (m.type === 'assistant') {
          sessionId = m.session_id ?? sessionId;
          const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
          for (const block of blocks) {
            if (block.type === 'thinking' && block.thinking) {
              yield { type: 'thinking', text: block.thinking };
            } else if (block.type === 'text' && block.text) {
              lastText = block.text;
              yield { type: 'text', text: block.text };
            } else if (block.type === 'tool_use') {
              yield {
                type: 'tool_call',
                toolCallId: block.id ?? '',
                toolName: block.name ?? 'unknown',
                input: (block.input ?? {}) as Record<string, unknown>,
              };
            }
          }
          continue;
        }

        if (m.type === 'user') {
          // Tool results arrive as synthetic user messages.
          const content = m.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                yield {
                  type: 'tool_result',
                  toolCallId: block.tool_use_id ?? '',
                  toolName: '',
                  isError: Boolean(block.is_error),
                  summary: summariseToolResult(block.content),
                };
              }
            }
          }
          continue;
        }

        if (m.type === 'result') {
          sawResult = true;
          sessionId = m.session_id ?? sessionId;
          numTurns = m.num_turns ?? 0;
          usage = extractUsage(m);
          costUsd = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined;
          if (costUsd === undefined) costUsd = estimateCostUsd(input.model, usage);

          for (const denial of m.permission_denials ?? []) {
            yield {
              type: 'permission_denied',
              toolName: denial.tool_name ?? 'unknown',
              reason: 'The human denied this tool call.',
            };
          }

          if (m.subtype !== 'success' || m.is_error) {
            yield {
              type: 'error',
              error: new DomainError(
                'provider_error',
                String(m.error ?? m.result ?? 'The provider reported an error.'),
                { subtype: m.subtype, stopReason: m.stop_reason },
              ),
              recoverable: true,
            };
            return;
          }

          yield {
            type: 'completed',
            result: (m.result ?? lastText ?? '').trim(),
            sessionId,
            usage,
            costUsd,
            numTurns,
            durationMs: m.duration_ms ?? Date.now() - startedAt,
          };
          return;
        }
      }

      if (!sawResult) {
        // The stream ended without a result: the query was interrupted.
        yield {
          type: 'error',
          error: new DomainError(
            abort.signal.aborted ? 'cancelled' : 'provider_error',
            abort.signal.aborted
              ? 'The activation was cancelled.'
              : 'The provider stream ended before producing a result.',
          ),
          recoverable: !abort.signal.aborted,
        };
      }
    } catch (err) {
      if (abort.signal.aborted) {
        yield {
          type: 'error',
          error: new DomainError('cancelled', 'The activation was cancelled.'),
          recoverable: false,
        };
        return;
      }
      yield { type: 'error', error: toDomainError(err, 'provider_error'), recoverable: true };
    } finally {
      if (timeout) clearTimeout(timeout);
      input.signal?.removeEventListener('abort', onExternalAbort);
      this.activations.delete(input.activationId);
    }
  }

  /**
   * Bridges Claude's permission callback to the host's approval flow.
   * Tools the agent is outright denied never reach here (they are removed from
   * its context); this only fires for capabilities configured as `ask`.
   */
  private buildPermissionCallback(input: AgentRunInput, askTools: string[]) {
    const askSet = new Set(askTools);
    return async (
      toolName: string,
      toolInput: Record<string, unknown>,
    ): Promise<PermissionDecision> => {
      const group = groupForTool(toolName, TEAM_TOOL_SERVER);

      // Our own in-process tools are host code; they need no human approval.
      if (group === 'agent_messaging') return { behavior: 'allow' };

      // A `git: allow` grant permits git commands even when the shell is `ask`.
      if (toolName === 'Bash' && isGitCommand(toolInput)) {
        const gitMode = input.tools.find((t) => t.group === 'git')?.mode;
        if (gitMode === 'allow') return { behavior: 'allow' };
        if (gitMode === 'deny') {
          return { behavior: 'deny', message: 'This agent is not allowed to use git.' };
        }
      }

      if (!askSet.has(toolName) && group === undefined) {
        // An unmapped tool (a new built-in, an MCP tool) — treat as `ask`.
      }

      if (!input.onPermissionRequest) {
        return {
          behavior: 'deny',
          message: 'This action needs human approval but no approver is attached to the run.',
        };
      }

      return input.onPermissionRequest({
        runId: input.runId,
        agentId: input.agentId,
        toolName,
        input: toolInput,
        group,
        summary: `${describeToolCall(toolName, toolInput)} [${approvalCategoryFor(
          toolName,
          toolInput,
          group,
        )}]`,
      });
    };
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

export function qualifiedToolName(name: string): string {
  return `mcp__${TEAM_TOOL_SERVER}__${name}`;
}

function buildTeamToolServer(specs: ProviderToolSpec[]) {
  return createSdkMcpServer({
    name: TEAM_TOOL_SERVER,
    version: '1.0.0',
    instructions:
      'Tools for coordinating with your teammates: messaging, task management and memory. ' +
      'Prefer these over describing what you would like someone else to do.',
    alwaysLoad: true,
    tools: specs.map((spec) =>
      // The SDK infers the handler's argument type from the zod raw shape.
      // Our specs carry an opaque shape, so the bridge is typed at the seam.
      tool(
        spec.name,
        spec.description,
        spec.inputSchema as unknown as Record<string, never>,
        (async (args: Record<string, unknown>) => {
          try {
            const result = await spec.handler(args ?? {});
            return {
              content: [{ type: 'text' as const, text: result.text }],
              isError: result.isError ?? false,
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Tool failed: ${describeError(err)}` }],
              isError: true,
            };
          }
        }) as never,
      ),
    ),
  });
}

function extractUsage(result: RawResultMessage): TokenUsage {
  const total = emptyUsage();

  // `modelUsage` covers every model call the query made; prefer it.
  const modelUsage = result.modelUsage;
  if (modelUsage && typeof modelUsage === 'object') {
    let sawAny = false;
    for (const entry of Object.values(modelUsage)) {
      if (!entry || typeof entry !== 'object') continue;
      sawAny = true;
      total.inputTokens += num(entry.inputTokens);
      total.outputTokens += num(entry.outputTokens);
      total.cacheReadInputTokens += num(entry.cacheReadInputTokens);
      total.cacheCreationInputTokens += num(entry.cacheCreationInputTokens);
    }
    if (sawAny) return total;
  }

  const usage = result.usage;
  if (usage) {
    total.inputTokens = num(usage.input_tokens);
    total.outputTokens = num(usage.output_tokens);
    total.cacheReadInputTokens = num(usage.cache_read_input_tokens);
    total.cacheCreationInputTokens = num(usage.cache_creation_input_tokens);
  }
  return total;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function summariseToolResult(content: unknown): string {
  if (typeof content === 'string') return truncate(content, 400);
  if (Array.isArray(content)) {
    const text = content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: string }).text) : ''))
      .filter(Boolean)
      .join('\n');
    return truncate(text, 400);
  }
  return '';
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Minimal structural types for the SDK message stream.
 *
 * We deliberately do not import the SDK's message union: it is large, it
 * changes between releases, and we only consume a documented subset. Narrow
 * structural types keep this adapter resilient to additive SDK changes.
 * ------------------------------------------------------------------ */

interface RawContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface RawMessage {
  type: string;
  subtype?: string;
  session_id?: string;

  /** `system`/`init` */
  apiKeySource?: string;
  claude_code_version?: string;
  tools?: string[];

  /** `assistant`/`user` */
  message?: { content?: RawContentBlock[] | string };

  /** `result` */
  is_error?: boolean;
  result?: string;
  error?: unknown;
  stop_reason?: string | null;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, Record<string, unknown>>;
  permission_denials?: Array<{ tool_name?: string }>;
}

type RawResultMessage = RawMessage;

interface RawModelInfo {
  value: string;
  displayName: string;
  description: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
}
