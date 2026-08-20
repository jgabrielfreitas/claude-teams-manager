import { formatTokens, formatUsd, totalTokens } from './models.js';
import type { Budget, RunTotals } from './entities.js';

/**
 * Budgets, and what it means to run without one.
 *
 * A team can deliberately run **unmetered**: no token cap and no money cap,
 * because the work is worth whatever it costs and guessing a number in advance
 * only ever interrupts it halfway. What such a run must never lose is a way to
 * stop — so the rule is that spend caps are optional, but a stop condition is
 * not: time, interactions, or both.
 *
 * That invariant lives here rather than in a form, so the TUI, the web UI, the
 * HTTP API and YAML import cannot disagree about it.
 */

/** Nothing caps spend: neither tokens nor money. */
export function isUnmetered(budget: Budget | undefined): boolean {
  return budget !== undefined && budget.maxTokens === undefined && budget.maxCostUsd === undefined;
}

/** There is at least one condition that will eventually stop the run. */
export function isBounded(budget: Budget | undefined): boolean {
  if (!budget) return false;
  return (
    budget.maxTokens !== undefined ||
    budget.maxCostUsd !== undefined ||
    budget.maxDurationMinutes !== undefined ||
    budget.maxAgentActivations !== undefined
  );
}

/** What a run without spend caps still stops on, if anything. */
export function budgetStops(budget: Budget | undefined): {
  spend: boolean;
  time: boolean;
  interactions: boolean;
} {
  return {
    spend: budget?.maxTokens !== undefined || budget?.maxCostUsd !== undefined,
    time: budget?.maxDurationMinutes !== undefined,
    interactions: budget?.maxAgentActivations !== undefined,
  };
}

export const UNBOUNDED_BUDGET_MESSAGE =
  'A budget with no token or cost cap must still stop somewhere: set a time limit, a limit on agent interactions, or both.';

/**
 * The reason a budget cannot be saved, or undefined when it is fine.
 *
 * `undefined` (no budget at all) is not checked here: it means "use the
 * application default", which is resolved when a run starts.
 */
export function budgetProblem(budget: Budget | undefined): string | undefined {
  if (budget === undefined) return undefined;
  return isBounded(budget) ? undefined : UNBOUNDED_BUDGET_MESSAGE;
}

/**
 * Removes the spend caps, keeping whatever stop conditions are there.
 *
 * Falls back to a generous default pair when the budget had none, so turning
 * the switch on can never produce a run that goes forever.
 */
export function unmetered(
  budget: Budget | undefined,
  fallback: Budget = DEFAULT_UNMETERED_BUDGET,
): Budget {
  const time = budget?.maxDurationMinutes ?? fallback.maxDurationMinutes;
  const interactions = budget?.maxAgentActivations ?? fallback.maxAgentActivations;
  return {
    ...(time !== undefined ? { maxDurationMinutes: time } : {}),
    ...(interactions !== undefined ? { maxAgentActivations: interactions } : {}),
  };
}

/** The stop conditions an unmetered budget starts with when it had none. */
export const DEFAULT_UNMETERED_BUDGET: Budget = {
  maxDurationMinutes: 120,
  maxAgentActivations: 100,
};

/**
 * The out-of-the-box budget, and what the spend caps go back to when someone
 * turns metering on again. Defined here so the application default and the
 * form that restores it cannot drift apart.
 */
export const DEFAULT_BUDGET: Budget = {
  maxTokens: 2_000_000,
  maxCostUsd: 20,
  maxDurationMinutes: 60,
  maxAgentActivations: 60,
};

/** One line, for a card, a row, a transcript header or a terminal. */
export function describeBudget(budget: Budget | undefined): string {
  if (!budget) return 'application default';
  const parts: string[] = [];
  if (budget.maxTokens !== undefined) parts.push(`${budget.maxTokens.toLocaleString('en-US')} tokens`);
  if (budget.maxCostUsd !== undefined) parts.push(formatUsd(budget.maxCostUsd));
  if (isUnmetered(budget)) parts.push('no spend cap');
  if (budget.maxDurationMinutes !== undefined) parts.push(`${budget.maxDurationMinutes} min`);
  if (budget.maxAgentActivations !== undefined) {
    parts.push(`${budget.maxAgentActivations} interactions`);
  }
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ *
 * What stops a run
 * ------------------------------------------------------------------ */

export interface BudgetConsumption {
  totals: RunTotals;
  /** Wall-clock the run has been going, when that is meaningful. */
  elapsedMs?: number;
}

/**
 * Which limits to apply.
 *
 * `all` is the run doing its own work. `spend` is for work a human explicitly
 * asked for after the fact — answering a message about a finished run — where
 * the money guards still hold but the runaway guards do not: a question asked
 * two days later is not the run overrunning its clock, and one activation you
 * requested by hand is not an agent looping. Applying the wall-clock limit
 * there would refuse every follow-up for ever, which is not a budget being
 * enforced, it is a conversation being lost.
 */
export type BudgetScope = 'all' | 'spend';

/**
 * The reason a run must stop, or undefined when it may continue.
 *
 * A plain value rather than a throw, so callers can choose between finishing
 * gracefully and refusing outright — and pure, so the runtime, the core and
 * both UIs answer the question the same way.
 */
export function budgetStop(
  budget: Budget | undefined,
  consumption: BudgetConsumption,
  scope: BudgetScope = 'all',
): string | undefined {
  if (!budget) return undefined;
  const { totals } = consumption;
  const tokens = totalTokens(totals.usage);

  if (budget.maxTokens !== undefined && tokens >= budget.maxTokens) {
    return `Token budget exhausted (${formatTokens(tokens)} / ${formatTokens(budget.maxTokens)}).`;
  }
  if (budget.maxCostUsd !== undefined && totals.costUsd >= budget.maxCostUsd) {
    return `Cost budget exhausted (${formatUsd(totals.costUsd)} / ${formatUsd(budget.maxCostUsd)}).`;
  }
  if (scope === 'spend') return undefined;

  const elapsedMs = consumption.elapsedMs ?? 0;
  if (budget.maxDurationMinutes !== undefined && elapsedMs >= budget.maxDurationMinutes * 60_000) {
    return `Time budget exhausted (${Math.round(elapsedMs / 60_000)} / ${budget.maxDurationMinutes} min).`;
  }
  if (
    budget.maxAgentActivations !== undefined &&
    totals.agentActivations >= budget.maxAgentActivations
  ) {
    return `Activation budget exhausted (${totals.agentActivations} / ${budget.maxAgentActivations}).`;
  }
  return undefined;
}

/** True when no more money may be spent on this run as it stands. */
export function spendExhausted(budget: Budget | undefined, totals: RunTotals): boolean {
  return budgetStop(budget, { totals }, 'spend') !== undefined;
}
