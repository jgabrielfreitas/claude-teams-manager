/**
 * Model catalog.
 *
 * The domain stores `agent.model` as an opaque string so a user can type a
 * brand new model id the day it ships without waiting for a release of this
 * tool. This catalog only powers *pickers* and *display names*; it is never a
 * whitelist. `AgentProvider.getModels()` replaces it at runtime with whatever
 * the live provider reports (see ADR-004).
 */

export interface ModelDefinition {
  /** The identifier passed to the provider verbatim. */
  id: string;
  label: string;
  provider: string;
  description?: string;
  /** Canonical id this entry resolves to, when `id` is a moving alias. */
  resolvedModel?: string;
  /** Rough capability tier, used to order pickers. */
  tier?: 'frontier' | 'balanced' | 'fast';
  /** Whether the provider honours per-agent reasoning effort for this model. */
  supportsEffort?: boolean;
  /** USD per million tokens, when known. Used for local cost estimation only. */
  pricing?: { inputPerMTok: number; outputPerMTok: number };
  deprecated?: boolean;
}

/**
 * Fallback list for the Claude provider, used before/if live discovery fails.
 *
 * Aliases are listed first and are the defaults on purpose: they always resolve
 * to the current generation, so a team exported today keeps working after the
 * next model release. Pinned ids are available for reproducibility.
 */
export const BUILTIN_CLAUDE_MODELS: ModelDefinition[] = [
  {
    id: 'opus',
    label: 'Claude Opus (latest)',
    provider: 'claude',
    tier: 'frontier',
    supportsEffort: true,
    description: 'Highest capability. Architecture, review, hard reasoning.',
    pricing: { inputPerMTok: 15, outputPerMTok: 75 },
  },
  {
    id: 'sonnet',
    label: 'Claude Sonnet (latest)',
    provider: 'claude',
    tier: 'balanced',
    supportsEffort: true,
    description: 'Strong general coding model. The default workhorse.',
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
  },
  {
    id: 'haiku',
    label: 'Claude Haiku (latest)',
    provider: 'claude',
    tier: 'fast',
    supportsEffort: false,
    description: 'Fast and cheap. Good for mechanical, high-volume tasks.',
    pricing: { inputPerMTok: 1, outputPerMTok: 5 },
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8 (pinned)',
    provider: 'claude',
    tier: 'frontier',
    supportsEffort: true,
    pricing: { inputPerMTok: 15, outputPerMTok: 75 },
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5 (pinned)',
    provider: 'claude',
    tier: 'balanced',
    supportsEffort: true,
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5 (pinned)',
    provider: 'claude',
    tier: 'fast',
    supportsEffort: false,
    pricing: { inputPerMTok: 1, outputPerMTok: 5 },
  },
];

/**
 * Defaults intentionally use moving aliases so that stored teams never rot.
 * Any agent can be pinned to an exact id at any time.
 */
export const DEFAULT_MODEL = 'sonnet';
export const DEFAULT_ORCHESTRATOR_MODEL = 'opus';
export const DEFAULT_FAST_MODEL = 'haiku';

export function findModel(
  id: string,
  catalog: ModelDefinition[] = BUILTIN_CLAUDE_MODELS,
): ModelDefinition | undefined {
  const needle = id.trim().toLowerCase();
  return (
    catalog.find((m) => m.id.toLowerCase() === needle) ??
    catalog.find((m) => m.resolvedModel?.toLowerCase() === needle)
  );
}

/** Display label for any model id, falling back to the raw id for unknown models. */
export function modelLabel(id: string, catalog: ModelDefinition[] = BUILTIN_CLAUDE_MODELS): string {
  return findModel(id, catalog)?.label ?? id;
}

/** Compact label for dense views: "Opus", "Sonnet", "claude-opus-4-8". */
export function shortModelLabel(id: string): string {
  const norm = id.trim().toLowerCase();
  if (norm === 'opus' || norm.startsWith('claude-opus')) return 'Opus';
  if (norm === 'sonnet' || norm.startsWith('claude-sonnet')) return 'Sonnet';
  if (norm === 'haiku' || norm.startsWith('claude-haiku')) return 'Haiku';
  if (norm === 'fable' || norm.startsWith('claude-fable')) return 'Fable';
  return id;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

export function totalTokens(u: TokenUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;
}

/**
 * Best-effort local cost estimate, used only when the provider does not report
 * a real cost. Returns undefined when pricing for the model is unknown.
 */
export function estimateCostUsd(
  modelId: string,
  usage: TokenUsage,
  catalog: ModelDefinition[] = BUILTIN_CLAUDE_MODELS,
): number | undefined {
  const pricing = findModel(modelId, catalog)?.pricing;
  if (!pricing) return undefined;
  const inTok = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  return (
    (inTok / 1_000_000) * pricing.inputPerMTok + (usage.outputTokens / 1_000_000) * pricing.outputPerMTok
  );
}

export function formatUsd(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—';
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}
