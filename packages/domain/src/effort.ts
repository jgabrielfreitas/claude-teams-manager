/**
 * Reasoning effort as a *domain* concept.
 *
 * The domain deliberately does not know how any given provider spells this.
 * Providers translate an `AgentEffort` into whatever knob they expose
 * (thinking-token budget, an `effort` parameter, a system-prompt hint, ...).
 * See ADR-004.
 */
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'max'] as const;

export type AgentEffort = (typeof AGENT_EFFORTS)[number];

export const DEFAULT_EFFORT: AgentEffort = 'medium';

export function isAgentEffort(value: unknown): value is AgentEffort {
  return typeof value === 'string' && (AGENT_EFFORTS as readonly string[]).includes(value);
}

export interface EffortDescriptor {
  id: AgentEffort;
  label: string;
  description: string;
  /** Relative ordering, useful for sorting and for "at least this much effort" checks. */
  rank: number;
}

export const EFFORT_CATALOG: Record<AgentEffort, EffortDescriptor> = {
  low: {
    id: 'low',
    label: 'Low',
    description: 'Fast, shallow reasoning. Good for mechanical or well-specified work.',
    rank: 0,
  },
  medium: {
    id: 'medium',
    label: 'Medium',
    description: 'Balanced default. Suitable for most implementation work.',
    rank: 1,
  },
  high: {
    id: 'high',
    label: 'High',
    description: 'Deliberate reasoning. Architecture, review, tricky debugging.',
    rank: 2,
  },
  max: {
    id: 'max',
    label: 'Max',
    description: 'Maximum deliberation. Slowest and most expensive.',
    rank: 3,
  },
};

export function effortRank(effort: AgentEffort): number {
  return EFFORT_CATALOG[effort].rank;
}

export function compareEffort(a: AgentEffort, b: AgentEffort): number {
  return effortRank(a) - effortRank(b);
}

/** Coerce loose user/YAML input ("HIGH", "maximum", 3) to a valid effort. */
export function coerceEffort(value: unknown, fallback: AgentEffort = DEFAULT_EFFORT): AgentEffort {
  if (isAgentEffort(value)) return value;
  if (typeof value === 'number') {
    const found = AGENT_EFFORTS.find((e) => EFFORT_CATALOG[e].rank === value);
    if (found) return found;
  }
  if (typeof value === 'string') {
    const norm = value.trim().toLowerCase();
    if (isAgentEffort(norm)) return norm;
    const aliases: Record<string, AgentEffort> = {
      minimal: 'low',
      min: 'low',
      fast: 'low',
      normal: 'medium',
      default: 'medium',
      balanced: 'medium',
      deep: 'high',
      xhigh: 'max',
      maximum: 'max',
      ultra: 'max',
    };
    if (aliases[norm]) return aliases[norm];
  }
  return fallback;
}
