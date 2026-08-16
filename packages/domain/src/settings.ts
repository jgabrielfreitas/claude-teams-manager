import { DEFAULT_EFFORT } from './effort.js';
import { DEFAULT_MODEL, DEFAULT_ORCHESTRATOR_MODEL } from './models.js';
import { DEFAULT_ROUTING_LIMITS } from './routing.js';
import type { AppSettings } from './entities.js';

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
