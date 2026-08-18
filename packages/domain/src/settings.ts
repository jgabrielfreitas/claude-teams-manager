import { DEFAULT_EFFORT } from './effort.js';
import { DEFAULT_MODEL, DEFAULT_ORCHESTRATOR_MODEL } from './models.js';
import { DEFAULT_ROUTING_LIMITS } from './routing.js';
import { ISOLATED_SETUP, type AppSettings, type LocalSetup } from './entities.js';

export function defaultSettings(now = new Date()): AppSettings {
  return {
    onboardingCompleted: false,
    defaultModel: DEFAULT_MODEL,
    defaultOrchestratorModel: DEFAULT_ORCHESTRATOR_MODEL,
    defaultEffort: DEFAULT_EFFORT,
    provider: 'claude',
    defaultBudget: {
      maxTokens: 2_000_000,
      maxCostUsd: 20,
      maxDurationMinutes: 60,
      maxAgentActivations: 60,
    },
    requireApprovalFor: ['shell', 'destructive', 'git'],
    autoApproveAll: false,
    localSetup: { ...ISOLATED_SETUP },
    autoAnswerQuestions: false,
    questionTimeoutMs: 30 * 60 * 1000,
    maxHops: DEFAULT_ROUTING_LIMITS.maxHops,
    maxRecursionDepth: DEFAULT_ROUTING_LIMITS.maxRecursionDepth,
    askTimeoutMs: 5 * 60 * 1000,
    webPort: 4317,
    theme: 'auto',
    telemetry: false,
    updatedAt: now,
  };
}

/**
 * Fills in a stored or imported `localSetup`, which may predate the field or
 * come from a hand-edited file. Everything unknown falls back to isolation:
 * inheriting the machine's configuration is something you turn on, never
 * something that happens because a value was missing.
 */
export function normaliseLocalSetup(value: unknown): LocalSetup {
  const raw = (value ?? {}) as Partial<LocalSetup>;
  const sources = Array.isArray(raw.settingSources)
    ? raw.settingSources.filter((s): s is LocalSetup['settingSources'][number] =>
        s === 'user' || s === 'project' || s === 'local',
      )
    : [];
  const skills =
    raw.skills === 'all' || raw.skills === 'none'
      ? raw.skills
      : Array.isArray(raw.skills)
        ? raw.skills.filter((s) => typeof s === 'string' && s.trim().length > 0)
        : 'none';
  const executablePath =
    typeof raw.executablePath === 'string' && raw.executablePath.trim().length > 0
      ? raw.executablePath.trim()
      : undefined;

  return {
    settingSources: [...new Set(sources)],
    skills: Array.isArray(skills) && skills.length === 0 ? 'none' : skills,
    mcpServers: raw.mcpServers === true,
    ...(executablePath ? { executablePath } : {}),
  };
}

/** True when nothing of the local installation is being reused. */
export function isIsolatedSetup(setup: LocalSetup): boolean {
  return (
    setup.settingSources.length === 0 &&
    (setup.skills === 'none' || (Array.isArray(setup.skills) && setup.skills.length === 0)) &&
    !setup.mcpServers
  );
}
