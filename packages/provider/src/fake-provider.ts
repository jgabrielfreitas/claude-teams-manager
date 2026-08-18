import {
  BUILTIN_CLAUDE_MODELS,
  DomainError,
  emptyUsage,
  type LocalSetup,
  type ModelDefinition,
  type TokenUsage,
} from '@claude-team/domain';
import type {
  AgentEvent,
  AgentProvider,
  AgentRunInput,
  ProviderHealth,
  ProviderToolResult,
} from './types.js';

/**
 * A deterministic provider for tests and demos.
 *
 * It is a real implementation of the interface, not a stub: it honours
 * capability grants, invokes the host's in-process tools (so an orchestrator
 * scripted here really does create tasks and send messages through the runtime),
 * reports usage and cost, and can be cancelled. That is what lets the entire
 * runtime be tested without touching the Claude API.
 */

export type FakeStep =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; tool: string; args: Record<string, unknown> }
  /**
   * Simulates the agent reaching for a capability that requires approval,
   * exercising the real human-in-the-loop path end to end.
   */
  | { kind: 'guarded'; tool: string; input: Record<string, unknown>; group?: string }
  | { kind: 'fail'; message: string; recoverable?: boolean }
  | { kind: 'wait'; ms: number };

export interface FakeContext {
  input: AgentRunInput;
  /** 1 for the agent's first activation in this provider instance, 2 for the next... */
  activation: number;
  /** Results of tool calls made so far in this activation, in order. */
  toolResults: ProviderToolResult[];
}

export type FakeBehavior = FakeStep[] | ((ctx: FakeContext) => FakeStep[] | Promise<FakeStep[]>);

export interface FakeProviderOptions {
  /** Behaviour per agent handle. */
  behaviors?: Record<string, FakeBehavior>;
  /** Used for any agent without a specific behaviour. */
  defaultBehavior?: FakeBehavior;
  /** Artificial delay before each step, to exercise concurrency. */
  latencyMs?: number;
  usagePerActivation?: Partial<TokenUsage>;
  costPerActivation?: number;
  models?: ModelDefinition[];
}

/** Everything the fake saw, for assertions. */
export interface RecordedActivation {
  runId: string;
  activationId: string;
  agentId: string;
  agentHandle: string;
  model: string;
  effort: string;
  prompt: string;
  systemPrompt: string;
  cwd?: string;
  maxTurns?: number;
  sessionId?: string;
  customToolNames: string[];
  /** What the run decided to reuse from the local Claude Code installation. */
  localSetup?: LocalSetup;
}

export class FakeAgentProvider implements AgentProvider {
  readonly id = 'fake';
  readonly label = 'Fake provider (deterministic)';

  /** Every activation this provider has been asked to run, in order. */
  readonly activations: RecordedActivation[] = [];

  private readonly aborts = new Map<string, AbortController>();
  private readonly activationCounts = new Map<string, number>();

  constructor(private readonly options: FakeProviderOptions = {}) {}

  /** What a half-finished activation is treated as having spent. */
  private partialUsage(): TokenUsage {
    const full = { ...emptyUsage(), inputTokens: 1000, outputTokens: 200, ...this.options.usagePerActivation };
    return { ...full, inputTokens: Math.round(full.inputTokens / 2), outputTokens: Math.round(full.outputTokens / 2) };
  }

  /** Number of times a given agent handle was activated. */
  activationsOf(handle: string): RecordedActivation[] {
    return this.activations.filter((a) => a.agentHandle === handle);
  }

  async cancel(activationId: string): Promise<void> {
    this.aborts.get(activationId)?.abort();
    this.aborts.delete(activationId);
  }

  async getModels(): Promise<ModelDefinition[]> {
    return this.options.models ?? BUILTIN_CLAUDE_MODELS;
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { ok: true, detail: 'Fake provider is always available.', authenticated: true };
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const abort = new AbortController();
    this.aborts.set(input.activationId, abort);
    const onExternalAbort = () => abort.abort();
    input.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const count = (this.activationCounts.get(input.agentHandle) ?? 0) + 1;
    this.activationCounts.set(input.agentHandle, count);

    this.activations.push({
      runId: input.runId,
      activationId: input.activationId,
      agentId: input.agentId,
      agentHandle: input.agentHandle,
      model: input.model,
      effort: input.effort,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      cwd: input.cwd,
      maxTurns: input.maxTurns,
      sessionId: input.sessionId,
      localSetup: input.localSetup,
      customToolNames: input.customTools.map((t) => t.name),
    });

    const startedAt = Date.now();
    const sessionId = input.sessionId ?? `fake-session-${input.agentHandle}`;
    yield { type: 'started', sessionId, model: input.model, effort: input.effort };

    const toolResults: ProviderToolResult[] = [];
    let lastText = '';

    try {
      const behavior =
        this.options.behaviors?.[input.agentHandle] ??
        this.options.defaultBehavior ??
        defaultBehavior;

      const steps =
        typeof behavior === 'function'
          ? await behavior({ input, activation: count, toolResults })
          : behavior;

      for (const step of steps) {
        if (abort.signal.aborted) {
          yield {
            type: 'error',
            error: new DomainError('cancelled', 'The activation was cancelled.'),
            recoverable: false,
            usage: this.partialUsage(),
            costUsd: (this.options.costPerActivation ?? 0.01) / 2,
          };
          return;
        }

        if (this.options.latencyMs) await sleep(this.options.latencyMs, abort.signal);

        switch (step.kind) {
          case 'thinking':
            yield { type: 'thinking', text: step.text };
            break;

          case 'text':
            lastText = step.text;
            yield { type: 'text', text: step.text };
            break;

          case 'wait':
            await sleep(step.ms, abort.signal);
            break;

          case 'fail':
            yield {
              type: 'error',
              error: new DomainError('agent_failed', step.message),
              recoverable: step.recoverable ?? true,
            };
            return;

          case 'guarded': {
            const toolCallId = `fake-guard-${this.activations.length}-${toolResults.length}`;
            yield {
              type: 'tool_call',
              toolCallId,
              toolName: step.tool,
              input: step.input,
            };
            const decision = input.onPermissionRequest
              ? await input.onPermissionRequest({
                  runId: input.runId,
                  agentId: input.agentId,
                  toolName: step.tool,
                  input: step.input,
                  group: step.group,
                  summary: `${step.tool}(${JSON.stringify(step.input)})`,
                })
              : ({ behavior: 'deny', message: 'No approver attached.' } as const);

            if (decision.behavior === 'deny') {
              toolResults.push({ text: decision.message, isError: true });
              yield { type: 'permission_denied', toolName: step.tool, reason: decision.message };
              yield {
                type: 'tool_result',
                toolCallId,
                toolName: step.tool,
                isError: true,
                summary: decision.message,
              };
            } else {
              toolResults.push({ text: 'approved' });
              yield {
                type: 'tool_result',
                toolCallId,
                toolName: step.tool,
                isError: false,
                summary: 'approved',
              };
            }
            break;
          }

          case 'tool': {
            const toolCallId = `fake-tool-${this.activations.length}-${toolResults.length}`;
            yield {
              type: 'tool_call',
              toolCallId,
              toolName: step.tool,
              input: step.args,
            };
            const spec = input.customTools.find((t) => t.name === step.tool);
            if (!spec) {
              const summary = `Unknown tool "${step.tool}"`;
              toolResults.push({ text: summary, isError: true });
              yield {
                type: 'tool_result',
                toolCallId,
                toolName: step.tool,
                isError: true,
                summary,
              };
              break;
            }
            let result: ProviderToolResult;
            try {
              result = await spec.handler(step.args);
            } catch (err) {
              result = { text: err instanceof Error ? err.message : String(err), isError: true };
            }
            toolResults.push(result);
            yield {
              type: 'tool_result',
              toolCallId,
              toolName: step.tool,
              isError: result.isError ?? false,
              summary: result.text,
            };
            break;
          }
        }
      }

      const usage: TokenUsage = { ...emptyUsage(), inputTokens: 1000, outputTokens: 200, ...this.options.usagePerActivation };

      yield {
        type: 'completed',
        result: lastText || `${input.agentHandle} completed its activation.`,
        sessionId,
        usage,
        costUsd: this.options.costPerActivation ?? 0.01,
        numTurns: steps.length,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      if (abort.signal.aborted) {
        yield {
          type: 'error',
          error: new DomainError('cancelled', 'The activation was cancelled.'),
          recoverable: false,
          usage: this.partialUsage(),
          costUsd: (this.options.costPerActivation ?? 0.01) / 2,
        };
        return;
      }
      yield {
        type: 'error',
        error:
          err instanceof DomainError
            ? err
            : new DomainError('provider_error', err instanceof Error ? err.message : String(err)),
        recoverable: true,
      };
    } finally {
      input.signal?.removeEventListener('abort', onExternalAbort);
      this.aborts.delete(input.activationId);
    }
  }
}

const defaultBehavior: FakeBehavior = (ctx) => [
  { kind: 'thinking', text: `Considering: ${ctx.input.prompt.slice(0, 80)}` },
  {
    kind: 'text',
    text: `[${ctx.input.agentHandle}] done (model=${ctx.input.model}, effort=${ctx.input.effort}).`,
  },
];

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
