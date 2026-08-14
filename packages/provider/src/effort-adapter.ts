import type { AgentEffort } from '@claude-team/domain';

/**
 * Effort adapter (ADR-004).
 *
 * The domain has four levels. The Claude Agent SDK currently exposes five
 * (`low | medium | high | xhigh | max`) via its `effort` option. The mapping
 * below is deliberately explicit rather than a pass-through, so that a change
 * on either side is a one-line edit here instead of a migration.
 */

export type ClaudeEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORT_MAP: Record<AgentEffort, ClaudeEffortLevel> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
};

export function toClaudeEffort(effort: AgentEffort): ClaudeEffortLevel {
  return EFFORT_MAP[effort];
}

/**
 * Fallback thinking budget, used when a provider build does not accept the
 * `effort` option. Values are token budgets for extended thinking.
 */
const THINKING_BUDGET: Record<AgentEffort, number | undefined> = {
  low: undefined,
  medium: 4_000,
  high: 16_000,
  max: 32_000,
};

export function toThinkingBudget(effort: AgentEffort): number | undefined {
  return THINKING_BUDGET[effort];
}
