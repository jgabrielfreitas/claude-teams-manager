import { formatUsd } from './models.js';
import type { Budget } from './entities.js';

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
