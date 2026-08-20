import { ApiError, routes, type ApiErrorBody } from './routes.js';
import {
  reviveDates,
  type AgentDto,
  type AgentInspectionDto,
  type ApprovalDto,
  type CatalogDto,
  type DashboardDto,
  type EnvironmentDto,
  type MessageDto,
  type QuestionDto,
  type OnboardingStatusDto,
  type ProviderHealthDto,
  type RunDetailDto,
  type RunDto,
  type RunEventDto,
  type SearchHitDto,
  type SettingsDto,
  type TaskDto,
  type TeamWithAgentsDto,
  type WorkspaceDto,
} from './dto.js';

/**
 * Typed HTTP client used by the web UI.
 *
 * It mirrors `AppCore` method for method on purpose: the browser calls
 * `client.updateAgentEffort(...)`, the server handler calls
 * `core.updateAgentEffort(...)`, and there is no third place where the rule
 * could drift (ADR-001).
 */
export class ApiClient {
  constructor(
    private readonly baseUrl = '',
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });

    const text = await response.text();
    const body = text ? (JSON.parse(text) as unknown) : undefined;

    if (!response.ok) {
      const error = (body as ApiErrorBody | undefined)?.error;
      throw new ApiError(
        error?.code ?? 'http_error',
        error?.message ?? `Request failed with ${response.status}`,
        response.status,
        error?.details,
      );
    }

    return reviveDates(body as T);
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
  }

  private patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }

  private del<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  /* ---------------- Overview ---------------- */

  getDashboard = () => this.request<DashboardDto>(routes.dashboard());
  getActivity = (limit = 100) => this.request<RunEventDto[]>(routes.activity(limit));
  getCatalog = () => this.request<CatalogDto>(routes.catalog());
  search = (query: string) => this.request<SearchHitDto[]>(routes.search(query));

  /* ---------------- Settings & onboarding ---------------- */

  getSettings = () => this.request<SettingsDto>(routes.settings());
  updateSettings = (patch: Record<string, unknown>) =>
    this.patch<SettingsDto>(routes.settings(), patch);

  getOnboardingStatus = () => this.request<OnboardingStatusDto>(routes.onboardingStatus());
  detectEnvironment = () => this.request<EnvironmentDto>(routes.onboardingDetect());
  completeOnboarding = () => this.post<SettingsDto>(routes.onboardingComplete());
  checkProvider = () => this.post<ProviderHealthDto>(routes.providerCheck());
  inspectWorkspace = (path: string) => this.request<WorkspaceDto>(routes.workspaceInspect(path));

  /* ---------------- Teams ---------------- */

  listTeams = () => this.request<TeamWithAgentsDto[]>(routes.teams());
  getTeam = (id: string) => this.request<TeamWithAgentsDto>(routes.team(id));
  createTeam = (body: Record<string, unknown>) =>
    this.post<TeamWithAgentsDto>(routes.teams(), body);
  createTeamFromPreset = (body: Record<string, unknown>) =>
    this.post<TeamWithAgentsDto>(routes.teamFromPreset(), body);
  updateTeam = (id: string, patch: Record<string, unknown>) =>
    this.patch<TeamWithAgentsDto>(routes.team(id), patch);
  deleteTeam = (id: string) => this.del<{ ok: true }>(routes.team(id));
  duplicateTeam = (id: string, name?: string) =>
    this.post<TeamWithAgentsDto>(routes.teamDuplicate(id), { name });
  exportTeam = (id: string) => this.request<{ yaml: string }>(routes.teamExport(id));
  importTeam = (yaml: string, name?: string) =>
    this.post<{ team: TeamWithAgentsDto; warnings: string[] }>(routes.teamImport(), { yaml, name });

  /* ---------------- Agents ---------------- */

  listAgents = (teamId?: string) => this.request<AgentDto[]>(routes.agents(teamId));
  getAgent = (id: string) => this.request<AgentDto>(routes.agent(id));
  createAgent = (body: Record<string, unknown>) => this.post<AgentDto>(routes.agents(), body);
  createAgentFromTemplate = (body: Record<string, unknown>) =>
    this.post<AgentDto>(routes.agentFromTemplate(), body);
  updateAgent = (id: string, patch: Record<string, unknown>) =>
    this.patch<AgentDto>(routes.agent(id), patch);
  deleteAgent = (id: string) => this.del<{ ok: true }>(routes.agent(id));
  duplicateAgent = (id: string, body: { name?: string; handle?: string } = {}) =>
    this.post<AgentDto>(routes.agentDuplicate(id), body);
  /** Per-agent model — never applied to the rest of the team. */
  updateAgentModel = (id: string, model: string) =>
    this.post<AgentDto>(routes.agentModel(id), { model });
  /** Per-agent effort — never applied to the rest of the team. */
  updateAgentEffort = (id: string, effort: string) =>
    this.post<AgentDto>(routes.agentEffort(id), { effort });
  inspectAgent = (id: string, runId?: string) =>
    this.request<AgentInspectionDto>(routes.agentInspect(id, runId));

  /* ---------------- Runs ---------------- */

  listRuns = (teamId?: string) => this.request<RunDto[]>(routes.runs(teamId));
  getRun = (id: string) => this.request<RunDetailDto>(routes.run(id));
  startRun = (body: Record<string, unknown>) => this.post<RunDto>(routes.runs(), body);
  /** Starts a run that was created queued rather than auto-started. */
  startQueuedRun = (id: string) => this.post<RunDto>(routes.runStart(id));
  pauseRun = (id: string) => this.post<RunDto>(routes.runPause(id));
  resumeRun = (id: string) => this.post<RunDto>(routes.runResume(id));
  cancelRun = (id: string) => this.post<RunDto>(routes.runCancel(id));
  retryRun = (id: string) => this.post<RunDto>(routes.runRetry(id));
  deleteRun = (id: string) => this.del<{ ok: true }>(routes.run(id));
  /** Raises (or lowers) the limits of an existing run. */
  updateRunBudget = (id: string, budget: Record<string, unknown> | null) =>
    this.patch<RunDto>(routes.runBudget(id), budget as Record<string, unknown>);
  getRunEvents = (id: string, afterSeq = 0) =>
    this.request<RunEventDto[]>(routes.runEvents(id, afterSeq));
  /** The full run transcript, for copying to the clipboard. */
  exportRun = (id: string, options: { format?: string; includeDebug?: boolean } = {}) =>
    this.request<{ content: string; fileName: string; format: string }>(
      routes.runExport(id, options),
    );
  /** URL that makes the browser download the transcript as a file. */
  runDownloadUrl = (id: string, options: { format?: string; includeDebug?: boolean } = {}) =>
    `${this.baseUrl}${routes.runExport(id, { ...options, download: true })}`;
  getRunMessages = (id: string) => this.request<MessageDto[]>(routes.runMessages(id));
  getRunTasks = (id: string) => this.request<TaskDto[]>(routes.runTasks(id));

  /* ---------------- Messages & approvals ---------------- */

  sendMessage = (body: Record<string, unknown>) => this.post<MessageDto>(routes.messages(), body);
  listApprovals = (runId?: string) => this.request<ApprovalDto[]>(routes.approvals(runId));
  decideApproval = (approvalId: string, decision: string) =>
    this.post<{ ok: boolean }>(routes.approvalDecision(), { approvalId, decision });

  /** Questions an agent is blocked on, waiting for a human. */
  listQuestions = (runId?: string) => this.request<QuestionDto[]>(routes.questions(runId));
  /** `selected` are labels from the offered options; `text` is free-form. */
  answerQuestion = (questionId: string, answer: { selected?: string[]; text?: string }) =>
    this.post<{ ok: boolean }>(routes.questionAnswer(), { questionId, ...answer });

  /** URL of the SSE endpoint; the caller owns the `EventSource`. */
  streamUrl(): string {
    return `${this.baseUrl}${routes.stream()}`;
  }
}
