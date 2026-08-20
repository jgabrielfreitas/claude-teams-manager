import {
  DomainError,
  addUsage,
  budgetStop,
  emptyUsage,
  totalTokens,
  type Budget,
  type BudgetScope,
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
    private budget: Budget | undefined,
    private readonly startedAt: number,
    private readonly onWarning: (message: string) => void = () => {},
  ) {}

  /**
   * Replaces the limits mid-flight, which is what raising a budget means.
   *
   * The warning marks are cleared with it: 80% of the old cost cap is not 80%
   * of the new one, and someone who just raised their budget should be told
   * again when the new one starts running out.
   */
  replaceBudget(budget: Budget | undefined): void {
    this.budget = budget;
    this.warnedAt.clear();
  }

  get limits(): Budget | undefined {
    return this.budget;
  }

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
   *
   * The rule itself lives in the domain (`budgetStop`), so the UIs can tell you
   * a run has no budget left without asking the engine that is not running.
   */
  exceeded(now = Date.now(), scope: BudgetScope = 'all'): string | undefined {
    return budgetStop(this.budget, { totals: this.totals, elapsedMs: this.elapsedMs(now) }, scope);
  }

  assertWithinBudget(now = Date.now()): void {
    const reason = this.exceeded(now);
    if (reason) throw new DomainError('budget_exceeded', reason, { totals: this.totals });
  }

  /** Fraction of the tightest configured limit already consumed, 0..1. */
  pressure(now = Date.now()): number {
    return this.tightest(now).ratio;
  }

  /**
   * The limit closest to being reached, and what it is.
   *
   * The name matters in the warning: an unmetered run has no money limit at
   * all, so telling someone they have "used 80% of their budget" would be
   * describing a cap that does not exist. It is 80% of their *time*, or of
   * their agent interactions, and the warning says which.
   */
  private tightest(now = Date.now()): { ratio: number; limit: string } {
    const b = this.budget;
    if (!b) return { ratio: 0, limit: 'budget' };

    const candidates: Array<{ ratio: number; limit: string }> = [];
    if (b.maxTokens) candidates.push({ ratio: totalTokens(this.usage) / b.maxTokens, limit: 'token budget' });
    if (b.maxCostUsd) candidates.push({ ratio: this.costUsd / b.maxCostUsd, limit: 'cost budget' });
    if (b.maxDurationMinutes) {
      candidates.push({
        ratio: this.elapsedMs(now) / (b.maxDurationMinutes * 60_000),
        limit: 'time limit',
      });
    }
    if (b.maxAgentActivations) {
      candidates.push({
        ratio: this.activations / b.maxAgentActivations,
        limit: 'agent interaction limit',
      });
    }
    if (candidates.length === 0) return { ratio: 0, limit: 'budget' };

    const worst = candidates.reduce((a, b2) => (b2.ratio > a.ratio ? b2 : a));
    return { ratio: Math.min(1, worst.ratio), limit: worst.limit };
  }

  private emitWarnings(): void {
    const { ratio, limit } = this.tightest();
    for (const threshold of [0.5, 0.8, 0.95]) {
      const key = String(threshold);
      if (ratio >= threshold && !this.warnedAt.has(key)) {
        this.warnedAt.add(key);
        this.onWarning(`Run has used ${Math.round(ratio * 100)}% of its ${limit}.`);
      }
    }
  }
}
