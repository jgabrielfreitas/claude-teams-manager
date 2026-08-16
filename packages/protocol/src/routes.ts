/**
 * The HTTP + SSE contract between the web server and the web client.
 *
 * It exists so that the browser never re-derives a URL or a payload shape by
 * hand, and so that adding an endpoint is a compile error on both sides until
 * both are updated. Controllers implement these routes by delegating straight
 * to the application core — no business rules live in them (ADR-001).
 */

export const API_PREFIX = '/api';

export const routes = {
  health: () => `${API_PREFIX}/health`,

  dashboard: () => `${API_PREFIX}/dashboard`,
  activity: (limit = 100) => `${API_PREFIX}/activity?limit=${limit}`,
  search: (query: string) => `${API_PREFIX}/search?q=${encodeURIComponent(query)}`,

  catalog: () => `${API_PREFIX}/catalog`,

  settings: () => `${API_PREFIX}/settings`,

  onboardingStatus: () => `${API_PREFIX}/onboarding`,
  onboardingDetect: () => `${API_PREFIX}/onboarding/detect`,
  onboardingComplete: () => `${API_PREFIX}/onboarding/complete`,
  providerCheck: () => `${API_PREFIX}/provider/check`,

  teams: () => `${API_PREFIX}/teams`,
  team: (id: string) => `${API_PREFIX}/teams/${id}`,
  teamFromPreset: () => `${API_PREFIX}/teams/from-preset`,
  teamDuplicate: (id: string) => `${API_PREFIX}/teams/${id}/duplicate`,
  teamExport: (id: string) => `${API_PREFIX}/teams/${id}/export`,
  teamImport: () => `${API_PREFIX}/teams/import`,

  agents: (teamId?: string) =>
    teamId ? `${API_PREFIX}/agents?teamId=${encodeURIComponent(teamId)}` : `${API_PREFIX}/agents`,
  agent: (id: string) => `${API_PREFIX}/agents/${id}`,
  agentFromTemplate: () => `${API_PREFIX}/agents/from-template`,
  agentDuplicate: (id: string) => `${API_PREFIX}/agents/${id}/duplicate`,
  agentModel: (id: string) => `${API_PREFIX}/agents/${id}/model`,
  agentEffort: (id: string) => `${API_PREFIX}/agents/${id}/effort`,
  agentInspect: (id: string, runId?: string) =>
    runId
      ? `${API_PREFIX}/agents/${id}/inspect?runId=${encodeURIComponent(runId)}`
      : `${API_PREFIX}/agents/${id}/inspect`,

  runs: (teamId?: string) =>
    teamId ? `${API_PREFIX}/runs?teamId=${encodeURIComponent(teamId)}` : `${API_PREFIX}/runs`,
  run: (id: string) => `${API_PREFIX}/runs/${id}`,
  /** Starts a run that was created queued (`autoStart: false`). */
  runStart: (id: string) => `${API_PREFIX}/runs/${id}/start`,
  runPause: (id: string) => `${API_PREFIX}/runs/${id}/pause`,
  runResume: (id: string) => `${API_PREFIX}/runs/${id}/resume`,
  runCancel: (id: string) => `${API_PREFIX}/runs/${id}/cancel`,
  runRetry: (id: string) => `${API_PREFIX}/runs/${id}/retry`,
  runEvents: (id: string, afterSeq = 0) => `${API_PREFIX}/runs/${id}/events?afterSeq=${afterSeq}`,
  /**
   * The whole run as one document. `download=1` makes the browser save it;
   * without it the body is returned for copying to the clipboard.
   */
  runExport: (
    id: string,
    options: { format?: string; includeDebug?: boolean; download?: boolean } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.format) params.set('format', options.format);
    if (options.includeDebug) params.set('includeDebug', '1');
    if (options.download) params.set('download', '1');
    const query = params.toString();
    return `${API_PREFIX}/runs/${id}/export${query ? `?${query}` : ''}`;
  },
  runMessages: (id: string) => `${API_PREFIX}/runs/${id}/messages`,
  runTasks: (id: string) => `${API_PREFIX}/runs/${id}/tasks`,

  messages: () => `${API_PREFIX}/messages`,

  approvals: (runId?: string) =>
    runId ? `${API_PREFIX}/approvals?runId=${encodeURIComponent(runId)}` : `${API_PREFIX}/approvals`,
  approvalDecision: () => `${API_PREFIX}/approvals/decision`,

  /** Questions an agent is waiting on a human to answer. */
  questions: (runId?: string) =>
    runId ? `${API_PREFIX}/questions?runId=${encodeURIComponent(runId)}` : `${API_PREFIX}/questions`,
  questionAnswer: () => `${API_PREFIX}/questions/answer`,

  workspaceInspect: (path: string) =>
    `${API_PREFIX}/workspace?path=${encodeURIComponent(path)}`,

  /** Server-sent events carrying the core's `AppEvent` stream. */
  stream: () => `${API_PREFIX}/stream`,
} as const;

/** Uniform error body, so the client can react to `code` rather than text. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
