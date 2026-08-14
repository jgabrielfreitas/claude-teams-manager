import {
  DomainError,
  addUsage,
  emptyUsage,
  formatUsd,
  totalTokens,
  type Budget,
  type RunTotals,
  type TokenUsage,
} from '@claude-team/domain';

/**
 * Budget enforcement.
 *
 * Checked in two places: before an activation is dispatched (so we never start
 * work we cannot pay for) and after it returns (so an over-spend stops the run
 * immediately rather than at the next natural boundary).
 */
export class BudgetTracker {
  private usage: TokenUsage = emptyUsage();
  private costUsd = 0;
  private activations = 0;
  private toolCalls = 0;
  private messages = 0;
  private warnedAt = new Set<string>();

  constructor(
    private readonly budget: Budget | undefined,
    private readonly startedAt: number,
    private readonly onWarning: (message: string) => void = () => {},
  ) {}

  get totals(): RunTotals {
    return {
      usage: { ...this.usage },
      costUsd: this.costUsd,
      agentActivations: this.activations,
      toolCalls: this.toolCalls,
      messages: this.messages,
    };
  }

  /** Restores totals when resuming a run that was persisted earlier. */
  restore(totals: RunTotals): void {
    this.usage = { ...totals.usage };
    this.costUsd = totals.costUsd;
    this.activations = totals.agentActivations;
    this.toolCalls = totals.toolCalls;
    this.messages = totals.messages;
  }

  recordActivation(usage: TokenUsage, costUsd: number | undefined): void {
    this.activations += 1;
    this.usage = addUsage(this.usage, usage);
    if (typeof costUsd === 'number' && Number.isFinite(costUsd)) this.costUsd += costUsd;
    this.emitWarnings();
  }

  recordToolCall(): void {
    this.toolCalls += 1;
  }

  recordMessage(): void {
    this.messages += 1;
  }

  elapsedMs(now = Date.now()): number {
    return now - this.startedAt;
  }

  /**
   * Returns the reason the run must stop, or undefined when it may continue.
   * Kept as a plain value (not a throw) so callers can decide between
   * "finish gracefully" and "abort".
   */
  exceeded(now = Date.now()): string | undefined {
    const b = this.budget;
    if (!b) return undefined;

    if (b.maxTokens !== undefined && totalTokens(this.usage) >= b.maxTokens) {
      return `Token budget exhausted (${totalTokens(this.usage)} / ${b.maxTokens}).`;
    }
    if (b.maxCostUsd !== undefined && this.costUsd >= b.maxCostUsd) {
      return `Cost budget exhausted (${formatUsd(this.costUsd)} / ${formatUsd(b.maxCostUsd)}).`;
    }
    if (b.maxDurationMinutes !== undefined && this.elapsedMs(now) >= b.maxDurationMinutes * 60_000) {
      return `Time budget exhausted (${Math.round(this.elapsedMs(now) / 60_000)} / ${b.maxDurationMinutes} min).`;
    }
    if (b.maxAgentActivations !== undefined && this.activations >= b.maxAgentActivations) {
      return `Activation budget exhausted (${this.activations} / ${b.maxAgentActivations}).`;
    }
    return undefined;
  }

  assertWithinBudget(now = Date.now()): void {
    const reason = this.exceeded(now);
    if (reason) throw new DomainError('budget_exceeded', reason, { totals: this.totals });
  }

  /** Fraction of the tightest configured limit already consumed, 0..1. */
  pressure(now = Date.now()): number {
    const b = this.budget;
    if (!b) return 0;
    const ratios: number[] = [];
    if (b.maxTokens) ratios.push(totalTokens(this.usage) / b.maxTokens);
    if (b.maxCostUsd) ratios.push(this.costUsd / b.maxCostUsd);
    if (b.maxDurationMinutes) ratios.push(this.elapsedMs(now) / (b.maxDurationMinutes * 60_000));
    if (b.maxAgentActivations) ratios.push(this.activations / b.maxAgentActivations);
    return ratios.length ? Math.min(1, Math.max(...ratios)) : 0;
  }

  private emitWarnings(): void {
    const p = this.pressure();
    for (const threshold of [0.5, 0.8, 0.95]) {
      const key = String(threshold);
      if (p >= threshold && !this.warnedAt.has(key)) {
        this.warnedAt.add(key);
        this.onWarning(`Run has used ${Math.round(p * 100)}% of its budget.`);
      }
    }
  }
}
