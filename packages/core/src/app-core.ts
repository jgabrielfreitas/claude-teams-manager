import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  AGENT_TEMPLATES,
  BUILTIN_CLAUDE_MODELS,
  EFFORT_CATALOG,
  TEAM_PRESETS,
  TOOL_GROUP_CATALOG,
  answerQuestionSchema,
  approvalDecisionSchema,
  cloneAgent as cloneAgentEntity,
  createAgent as createAgentEntity,
  createEvent as createEventEntity,
  createMessage as createMessageEntity,
  conflict,
  createTeam as createTeamEntity,
  createAgentSchema,
  createTeamSchema,
  defaultSettings,
  defaultToolPermissions,
  findPreset,
  findTemplate,
  illegalState,
  invalid,
  notFound,
  parsePortableTeam,
  sendAgentMessageSchema,
  startRunSchema,
  taskProgress,
  toPortableTeam,
  updateAgentSchema,
  updateSettingsSchema,
  updateTeamSchema,
  DomainError,
  budgetSchema,
  budgetStop,
  spendExhausted,
  toDomainError,
  uniqueSlug,
  type Agent,
  type AgentEffort,
  type AgentMessage,
  type AgentQuestion,
  type AgentStatus,
  type AppSettings,
  type ApprovalRequest,
  type Budget,
  type ModelDefinition,
  type Run,
  type RunEvent,
  type Task,
  type Team,
  type TeamWithAgents,
  type ToolPermission,
} from '@claude-team/domain';
import type { Storage } from '@claude-team/persistence';
import {
  availableProviders,
  detectClaudeEnvironment,
  type AgentProvider,
  type ClaudeEnvironment,
  type ProviderHealth,
} from '@claude-team/provider';
import { RunManager, DEFAULT_ENGINE_OPTIONS, type RunEngineOptions } from '@claude-team/runtime';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EventBus, type AppEvent, type AppEventListener } from './event-bus.js';
import {
  defaultTeamsDir,
  pruneRenamedFiles,
  removeTeamFile,
  teamFileName,
  writeTeamFile,
} from './team-files.js';
import { acquireInstanceLock, type InstanceInfo, type InstanceLock } from './instance-lock.js';
import {
  formatTranscript,
  transcriptFileName,
  transcriptMimeType,
  type TranscriptFormat,
  type TranscriptOptions,
} from './transcript.js';
import { search, type SearchHit } from './search.js';
import { describeGit, expandPath, inspectWorkspace, type WorkspaceInfo } from './workspace.js';

/**
 * The application core (ADR-001).
 *
 * Every use case lives here. The TUI calls these methods in-process; the web
 * server calls the same methods from its HTTP handlers. Neither contains a
 * business rule of its own — if behaviour needs to change, it changes once.
 */

export interface AppCoreDeps {
  storage: Storage;
  provider: AgentProvider;
  /** Overrides for the engine; anything omitted comes from settings. */
  engineOptions?: Partial<RunEngineOptions>;
  /**
   * Where this process was invoked from. Runs it starts work here unless told
   * otherwise, which is what makes `claude-team` act on the folder you are
   * standing in, the way every other command-line tool does.
   */
  workspace?: string;
}

export interface RunDetail {
  run: Run;
  team: Team;
  agents: Agent[];
  tasks: Task[];
  messages: AgentMessage[];
  events: RunEvent[];
  approvals: ApprovalRequest[];
  questions: AgentQuestion[];
  progress: ReturnType<typeof taskProgress>;
  isActive: boolean;
}

export interface AgentInspection {
  agent: Agent;
  team: Team;
  currentTask?: Task;
  messageCount: number;
  unreadCount: number;
  toolCalls: number;
  runtimeMs: number;
  activations: number;
  lastEvents: RunEvent[];
  inbox: AgentMessage[];
  reachable: string[];
}

export interface ResolvedPresetMember {
  templateId: string;
  handle: string;
  name: string;
  role: string;
  description: string;
  /** The model this member will actually be created with. */
  model: string;
  /** The effort this member will actually be created with. */
  effort: AgentEffort;
  canMessage: string[];
  orchestrator: boolean;
}

export interface ResolvedPreset {
  id: string;
  name: string;
  description: string;
  members: ResolvedPresetMember[];
}

export interface DashboardView {
  teams: Array<TeamWithAgents & { activeRunId?: string }>;
  activeRuns: Run[];
  recentRuns: Run[];
  recentEvents: RunEvent[];
  pendingApprovals: ApprovalRequest[];
  pendingQuestions: AgentQuestion[];
  /** Task progress per active run, keyed by run id — so a dashboard needs one call. */
  progress: Record<string, ReturnType<typeof taskProgress>>;
  counts: { teams: number; agents: number; runs: number; runningAgents: number };
  settings: AppSettings;
}

export class AppCore {
  readonly events = new EventBus();
  readonly runs: RunManager;

  private settingsCache?: AppSettings;
  private modelsCache?: ModelDefinition[];
  private lock?: InstanceLock;

  constructor(private readonly deps: AppCoreDeps) {
    this.runs = new RunManager(
      {
        storage: deps.storage,
        provider: deps.provider,
        onEvent: (event) => this.events.emit({ type: 'run.event', runId: event.runId, event }),
        onAgentStatus: (agentId, status) =>
          this.events.emit({ type: 'agent.status', agentId, status }),
        onRunStatus: (runId, status) => {
          this.events.emit({ type: 'run.status', runId, status: status as Run['status'] });
        },
        onApproval: (approval) => this.events.emit({ type: 'approval', approval }),
        onQuestion: (question) => this.events.emit({ type: 'question', question }),
      },
      { ...DEFAULT_ENGINE_OPTIONS, ...(deps.engineOptions ?? {}) },
    );
  }

  get storage(): Storage {
    return this.deps.storage;
  }

  get provider(): AgentProvider {
    return this.deps.provider;
  }

  /** Applies migrations, recovers interrupted runs, and syncs engine options. */
  async init(): Promise<void> {
    await this.deps.storage.init();
    const settings = await this.getSettings();
    this.applySettingsToEngine(settings);
    this.warnAboutRiskyWorkspace();

    this.lock = acquireInstanceLock(this.deps.storage.describe().location);

    if (this.lock.isPrimary) {
      // Only the owning process may decide that a `running` row is orphaned.
      await this.runs.recoverInterrupted();
      await this.expireOrphanedApprovals();
      // Bring the YAML mirror up to date, including for databases that predate
      // it and for files deleted while the app was closed.
      await this.syncAllTeamFiles();
    } else {
      this.emit({
        type: 'notice',
        level: 'warn',
        message:
          `Another instance (pid ${this.lock.heldByPid}) is already running against this database. ` +
          'This one is read-mostly: it will not take over or recover runs that instance owns.',
      });
    }
  }

  /** Whether this process owns the runtime for its database. */
  instanceInfo(): InstanceInfo {
    return this.lock ?? { isPrimary: true };
  }

  /**
   * An approval request only means something while the agent that raised it is
   * still parked on it. A row left `pending` by a process that was killed can
   * never be answered, so it is expired here rather than reappearing on every
   * launch as a prompt that does nothing.
   */
  private async expireOrphanedApprovals(): Promise<void> {
    const active = new Set(this.runs.activeRunIds());
    const stale = (await this.deps.storage.approvals.list({ status: 'pending' })).filter(
      (a) => !active.has(a.runId),
    );
    for (const approval of stale) {
      await this.deps.storage.approvals.update({
        ...approval,
        status: 'expired',
        resolvedAt: new Date(),
      });
    }
  }

  async shutdown(): Promise<void> {
    await this.runs.shutdown();
    this.lock?.release();
    await this.deps.storage.close();
  }

  subscribe(listener: AppEventListener): () => void {
    return this.events.subscribe(listener);
  }

  private emit(event: AppEvent): void {
    this.events.emit(event);
  }

  /* ================================================================ *
   * Settings
   * ================================================================ */

  /**
   * The directory a run started now would work in, and why.
   *
   * Precedence: what the caller asked for, then where this process was invoked
   * from, then the team's own directory. The invocation directory beats the
   * team's on purpose — you are standing in a project and asking for work on
   * it. A team's directory is what remains for the cases with no terminal
   * behind them (a daemon, a scheduled run), and an agent pinned to its own
   * directory still overrides all of this.
   */
  async resolveWorkspace(input: {
    requested?: string;
    teamId?: string;
  }): Promise<{ path?: string; source: 'requested' | 'invocation' | 'team' | 'none' }> {
    if (input.requested?.trim()) return { path: expandPath(input.requested), source: 'requested' };
    if (this.deps.workspace?.trim()) {
      return { path: expandPath(this.deps.workspace), source: 'invocation' };
    }
    if (input.teamId) {
      const team = await this.deps.storage.teams.get(input.teamId);
      if (team?.workspace) return { path: team.workspace, source: 'team' };
    }
    return { source: 'none' };
  }

  /**
   * Agents write files and run commands in the workspace, so being launched
   * from `$HOME` or `/` is worth one line on screen. A warning, not a refusal:
   * it is a legitimate thing to do deliberately, and blocking it would be this
   * product deciding what someone's directories are for.
   */
  private warnAboutRiskyWorkspace(): void {
    const workspace = this.deps.workspace?.trim();
    if (!workspace) return;
    const risky = [homedir(), '/'].map((path) => path.replace(/\/$/, ''));
    if (!risky.includes(workspace.replace(/\/$/, ''))) return;
    this.emit({
      type: 'notice',
      level: 'warn',
      message: `Runs will work in ${workspace}. Agents write files there — start from a project directory, or set the workspace per team.`,
    });
  }

  /** Where this process was invoked from, for a UI that wants to show it. */
  invocationWorkspace(): string | undefined {
    return this.deps.workspace;
  }

  async getSettings(): Promise<AppSettings> {
    if (!this.settingsCache) this.settingsCache = await this.deps.storage.settings.get();
    return this.settingsCache;
  }

  async updateSettings(patch: unknown): Promise<AppSettings> {
    const parsed = updateSettingsSchema.parse(patch);
    const current = await this.getSettings();
    const next: AppSettings = {
      ...current,
      ...stripUndefined(parsed),
      defaultWorkspace:
        parsed.defaultWorkspace === null
          ? undefined
          : (parsed.defaultWorkspace ?? current.defaultWorkspace),
      teamsDir: parsed.teamsDir === null ? undefined : (parsed.teamsDir ?? current.teamsDir),
      updatedAt: new Date(),
    };

    const previousTeamsDir = this.teamsDirectory();
    this.settingsCache = await this.deps.storage.settings.save(next);
    this.applySettingsToEngine(this.settingsCache);

    // Pointing the mirror somewhere new must populate it, or the folder would
    // stay empty until the next time a team happened to change.
    if (this.teamsDirectory() !== previousTeamsDir) await this.syncAllTeamFiles();

    this.emit({ type: 'settings.changed' });
    return this.settingsCache;
  }

  async resetSettings(): Promise<AppSettings> {
    this.settingsCache = await this.deps.storage.settings.save(defaultSettings());
    this.applySettingsToEngine(this.settingsCache);
    this.emit({ type: 'settings.changed' });
    return this.settingsCache;
  }

  private applySettingsToEngine(settings: AppSettings): void {
    this.runs.setOptions({
      autoApproveAll: settings.autoApproveAll,
      localSetup: settings.localSetup,
      autoAnswerQuestions: settings.autoAnswerQuestions,
      questionTimeoutMs: settings.questionTimeoutMs,
      requireApprovalFor: settings.requireApprovalFor,
      maxHops: settings.maxHops,
      maxRecursionDepth: settings.maxRecursionDepth,
      askTimeoutMs: settings.askTimeoutMs,
      ...(this.deps.engineOptions ?? {}),
    });
  }

  /* ================================================================ *
   * Onboarding
   * ================================================================ */

  async isOnboardingNeeded(): Promise<boolean> {
    const settings = await this.getSettings();
    if (settings.onboardingCompleted) return false;
    const teams = await this.deps.storage.teams.list();
    return teams.length === 0;
  }

  /** Defaults to the directory runs will use, not merely to `process.cwd()`. */
  async detectEnvironment(cwd = this.deps.workspace ?? process.cwd()): Promise<{
    claude: ClaudeEnvironment;
    workspace: WorkspaceInfo;
    storage: { driver: string; location: string };
    existingTeams: number;
  }> {
    const [claude, workspace, teams] = await Promise.all([
      detectClaudeEnvironment(cwd),
      inspectWorkspace(cwd),
      this.deps.storage.teams.list(),
    ]);
    return {
      claude,
      workspace,
      storage: this.deps.storage.describe(),
      existingTeams: teams.length,
    };
  }

  async checkProvider(): Promise<ProviderHealth> {
    return this.deps.provider.healthCheck();
  }

  async completeOnboarding(): Promise<AppSettings> {
    return this.updateSettings({ onboardingCompleted: true });
  }

  /* ================================================================ *
   * Catalogs
   * ================================================================ */

  async listModels(): Promise<ModelDefinition[]> {
    if (this.modelsCache) return this.modelsCache;
    try {
      this.modelsCache = await this.deps.provider.getModels();
    } catch {
      this.modelsCache = BUILTIN_CLAUDE_MODELS;
    }
    return this.modelsCache;
  }

  /** Models plus any custom ids already in use, so a picker never hides one. */
  async listModelsInUse(): Promise<ModelDefinition[]> {
    const catalog = await this.listModels();
    const agents = await this.deps.storage.agents.listAll();
    const known = new Set(catalog.map((m) => m.id));
    const extra = [...new Set(agents.map((a) => a.model))]
      .filter((id) => !known.has(id))
      .map<ModelDefinition>((id) => ({ id, label: id, provider: 'custom' }));
    return [...catalog, ...extra];
  }

  listEfforts() {
    return Object.values(EFFORT_CATALOG);
  }

  listTemplates() {
    return AGENT_TEMPLATES;
  }

  /**
   * Presets with every member already resolved to the concrete handle, model
   * and effort `createTeamFromPreset` will actually use.
   *
   * The resolution chain (member override → template default) is applied here,
   * once, so a "this is what you will get" preview in either surface cannot
   * promise something the creation path does not produce.
   */
  listPresets(): ResolvedPreset[] {
    return TEAM_PRESETS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      members: preset.members.flatMap((member) => {
        const template = findTemplate(member.templateId);
        if (!template) return [];
        return [
          {
            templateId: member.templateId,
            handle: member.handle ?? template.handle,
            name: template.name,
            role: template.role,
            description: template.description,
            model: member.model ?? template.model,
            effort: member.effort ?? template.effort,
            canMessage: member.canMessage ?? ['*'],
            orchestrator: member.orchestrator ?? false,
          },
        ];
      }),
    }));
  }

  listToolGroups() {
    return Object.values(TOOL_GROUP_CATALOG);
  }

  /** Provider ids this build can run agents with, for the Settings picker. */
  listProviders(): Array<{ id: string; label: string; current: boolean }> {
    const current = this.deps.provider.id;
    return availableProviders().map((id) => ({
      id,
      label: id === 'claude' ? 'Claude (Agent SDK)' : id === 'fake' ? 'Fake (deterministic)' : id,
      current: id === current,
    }));
  }

  /* ================================================================ *
   * Teams
   * ================================================================ */

  async listTeams(): Promise<TeamWithAgents[]> {
    const teams = await this.deps.storage.teams.list();
    return Promise.all(teams.map((team) => this.hydrateTeam(team)));
  }

  async getTeam(teamId: string): Promise<TeamWithAgents> {
    const team = await this.deps.storage.teams.get(teamId);
    if (!team) throw notFound('Team', teamId);
    return this.hydrateTeam(team);
  }

  /**
   * Resolves whatever a human typed — an id, an exact name, or an unambiguous
   * prefix — to a team. Used by the CLI and by both command palettes, so
   * "which team did they mean" is answered the same way everywhere.
   */
  async findTeam(ref: string): Promise<TeamWithAgents> {
    const needle = ref.trim();
    if (!needle) throw invalid('Which team?');

    const teams = await this.deps.storage.teams.list();
    const byId = teams.find((t) => t.id === needle);
    if (byId) return this.hydrateTeam(byId);

    const lower = needle.toLowerCase();
    const exact = teams.filter((t) => t.name.toLowerCase() === lower);
    if (exact.length === 1) return this.hydrateTeam(exact[0]);
    if (exact.length > 1) {
      throw conflict(`More than one team is called "${needle}". Use its id instead.`, {
        ids: exact.map((t) => t.id),
      });
    }

    const prefix = teams.filter((t) => t.name.toLowerCase().startsWith(lower));
    if (prefix.length === 1) return this.hydrateTeam(prefix[0]);
    if (prefix.length > 1) {
      throw conflict(
        `"${needle}" matches ${prefix.length} teams: ${prefix.map((t) => t.name).join(', ')}.`,
        { ids: prefix.map((t) => t.id) },
      );
    }

    throw notFound('Team', needle);
  }

  private async hydrateTeam(team: Team): Promise<TeamWithAgents> {
    const agents = await this.deps.storage.agents.listByTeam(team.id);
    return { ...team, agents };
  }

  /* ---------------- Team files ---------------- */

  /**
   * Directory holding the YAML mirror of every team, or undefined when the
   * store has no location on disk (in-memory, i.e. tests).
   */
  teamsDirectory(): string | undefined {
    const configured = this.settingsCache?.teamsDir?.trim();
    if (configured) return expandPath(configured);
    return defaultTeamsDir(this.deps.storage.describe().location);
  }

  /** Absolute path of a team's file, for showing in the UI. */
  async teamFilePath(teamId: string): Promise<string | undefined> {
    const dir = this.teamsDirectory();
    if (!dir) return undefined;
    const team = await this.deps.storage.teams.get(teamId);
    return team ? join(dir, teamFileName(team)) : undefined;
  }

  /**
   * Rewrites a team's YAML file. Called after anything that changes the team's
   * shape, so the folder is always an accurate, importable snapshot.
   *
   * A failure here must never fail the operation the user actually asked for:
   * the database is the source of truth and the file is a convenience, so a
   * read-only disk downgrades to a notice.
   */
  private async syncTeamFile(teamId: string): Promise<void> {
    const dir = this.teamsDirectory();
    if (!dir) return;
    try {
      const team = await this.deps.storage.teams.get(teamId);
      if (!team) return;
      const agents = await this.deps.storage.agents.listByTeam(teamId);
      pruneRenamedFiles(dir, team);
      writeTeamFile(dir, team, agents);
    } catch (err) {
      this.emit({
        type: 'notice',
        level: 'warn',
        message: `Could not write the team file in ${dir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  private async forgetTeamFile(team: Team): Promise<void> {
    const dir = this.teamsDirectory();
    if (!dir) return;
    try {
      removeTeamFile(dir, team);
    } catch {
      /* the mirror is a convenience; never fail a delete over it */
    }
  }

  /** Rewrites every team file. Used on startup and after changing the folder. */
  async syncAllTeamFiles(): Promise<number> {
    const dir = this.teamsDirectory();
    if (!dir) return 0;
    const teams = await this.deps.storage.teams.list();
    for (const team of teams) await this.syncTeamFile(team.id);
    return teams.length;
  }

  async createTeam(input: unknown): Promise<TeamWithAgents> {
    const parsed = createTeamSchema.parse(input);
    // A team created from a terminal standing in a project belongs to that
    // project; nothing else is a better guess.
    const workspace = await this.resolveWorkspace({ requested: parsed.workspace });
    const team = createTeamEntity({
      ...parsed,
      workspace: workspace.path,
    });
    await this.deps.storage.teams.create(team);
    await this.syncTeamFile(team.id);
    this.emit({ type: 'team.changed', teamId: team.id });
    return { ...team, agents: [] };
  }

  /**
   * Creates a team from a preset, expanding every member template into a real,
   * fully editable agent — including its own model and effort.
   */
  async createTeamFromPreset(input: {
    presetId: string;
    name?: string;
    workspace?: string;
    /** Per-handle overrides chosen in the wizard. */
    overrides?: Record<string, { model?: string; effort?: AgentEffort }>;
  }): Promise<TeamWithAgents> {
    const preset = findPreset(input.presetId);
    if (!preset) throw notFound('Preset', input.presetId);

    const settings = await this.getSettings();
    const team = createTeamEntity({
      name: input.name?.trim() || preset.name,
      description: preset.description,
      workspace:
        (await this.resolveWorkspace({ requested: input.workspace })).path ??
        settings.defaultWorkspace,
      presetId: preset.id,
      budget: settings.defaultBudget,
    });
    await this.deps.storage.teams.create(team);

    const handles: string[] = [];
    const agents: Agent[] = [];

    for (const [index, member] of preset.members.entries()) {
      const template = findTemplate(member.templateId);
      if (!template) continue;
      const override = input.overrides?.[member.handle ?? template.handle];
      const agent = createAgentEntity(
        {
          teamId: team.id,
          handle: member.handle ?? template.handle,
          name: template.name,
          role: template.role,
          description: template.description,
          systemPrompt: template.systemPrompt,
          model: override?.model ?? member.model ?? template.model,
          effort: override?.effort ?? member.effort ?? template.effort,
          tools: template.tools.map((t) => ({ ...t })),
          communicationRules: template.communicationRules,
          canMessage: member.canMessage ?? ['*'],
          templateId: template.id,
          order: index,
        },
        handles,
      );
      handles.push(agent.handle);
      agents.push(agent);
      await this.deps.storage.agents.create(agent);
    }

    const orchestratorMember = preset.members.find((m) => m.orchestrator);
    const orchestrator = orchestratorMember
      ? agents.find((a) => a.handle === (orchestratorMember.handle ?? findTemplate(orchestratorMember.templateId)?.handle))
      : agents[0];

    const updated: Team = {
      ...team,
      orchestratorId: orchestrator?.id,
      defaultAgentId: orchestrator?.id,
      updatedAt: new Date(),
    };
    await this.deps.storage.teams.update(updated);
    await this.syncTeamFile(team.id);

    this.emit({ type: 'team.changed', teamId: team.id });
    return { ...updated, agents };
  }

  async updateTeam(teamId: string, patch: unknown): Promise<TeamWithAgents> {
    const parsed = updateTeamSchema.parse(patch);
    const team = await this.deps.storage.teams.get(teamId);
    if (!team) throw notFound('Team', teamId);
    const agents = await this.deps.storage.agents.listByTeam(teamId);

    for (const key of ['orchestratorId', 'defaultAgentId'] as const) {
      const value = parsed[key];
      if (value && !agents.some((a) => a.id === value)) {
        throw invalid(`Agent "${value}" is not a member of this team.`);
      }
    }

    const next: Team = {
      ...team,
      name: parsed.name ?? team.name,
      description: nullable(parsed.description, team.description),
      workspace: parsed.workspace === null ? undefined : parsed.workspace ? expandPath(parsed.workspace) : team.workspace,
      orchestratorId: nullable(parsed.orchestratorId, team.orchestratorId),
      defaultAgentId: nullable(parsed.defaultAgentId, team.defaultAgentId),
      budget: parsed.budget === null ? undefined : (parsed.budget ?? team.budget),
      updatedAt: new Date(),
    };
    await this.deps.storage.teams.update(next);
    await this.syncTeamFile(teamId);
    this.emit({ type: 'team.changed', teamId });
    return { ...next, agents };
  }

  async deleteTeam(teamId: string): Promise<void> {
    const team = await this.deps.storage.teams.get(teamId);
    if (!team) throw notFound('Team', teamId);
    const active = this.runs.activeRunIds();
    const runs = await this.deps.storage.runs.list({ teamId });
    if (runs.some((r) => active.includes(r.id))) {
      throw illegalState('This team has a run in progress. Cancel it before deleting the team.');
    }
    await this.deps.storage.teams.delete(teamId);
    await this.forgetTeamFile(team);
    this.emit({ type: 'team.changed', teamId: null });
  }

  async duplicateTeam(teamId: string, name?: string): Promise<TeamWithAgents> {
    const source = await this.getTeam(teamId);
    const team = createTeamEntity({
      name: name?.trim() || `${source.name} (copy)`,
      description: source.description,
      workspace: source.workspace,
      budget: source.budget,
      presetId: source.presetId,
    });
    await this.deps.storage.teams.create(team);

    const handles: string[] = [];
    const idMap = new Map<string, string>();
    const agents: Agent[] = [];

    for (const original of source.agents) {
      const copy = cloneAgentEntity(
        original,
        { teamId: team.id, name: original.name, handle: original.handle },
        handles,
      );
      handles.push(copy.handle);
      idMap.set(original.id, copy.id);
      agents.push(copy);
      await this.deps.storage.agents.create(copy);
    }

    const updated: Team = {
      ...team,
      orchestratorId: source.orchestratorId ? idMap.get(source.orchestratorId) : undefined,
      defaultAgentId: source.defaultAgentId ? idMap.get(source.defaultAgentId) : undefined,
      updatedAt: new Date(),
    };
    await this.deps.storage.teams.update(updated);
    await this.syncTeamFile(team.id);
    this.emit({ type: 'team.changed', teamId: team.id });
    return { ...updated, agents };
  }

  /* ---------------- Import / export ---------------- */

  async exportTeam(teamId: string): Promise<string> {
    const team = await this.getTeam(teamId);
    const doc = toPortableTeam(team, team.agents);
    return stringifyYaml(stripUndefinedDeep(doc), { lineWidth: 100 });
  }

  async importTeam(yamlText: string, opts: { name?: string } = {}): Promise<{
    team: TeamWithAgents;
    warnings: string[];
  }> {
    let raw: unknown;
    try {
      raw = parseYaml(yamlText);
    } catch (err) {
      throw invalid(`This is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = parsePortableTeam(raw);

    const team = createTeamEntity({
      ...parsed.team,
      name: opts.name?.trim() || parsed.team.name,
      workspace: parsed.team.workspace ? expandPath(parsed.team.workspace) : undefined,
    });
    await this.deps.storage.teams.create(team);

    const handles: string[] = [];
    const byHandle = new Map<string, Agent>();
    const agents: Agent[] = [];

    for (const spec of parsed.agents) {
      const agent = createAgentEntity({ ...spec, teamId: team.id }, handles);
      handles.push(agent.handle);
      byHandle.set(spec.handle, agent);
      agents.push(agent);
      await this.deps.storage.agents.create(agent);
    }

    const updated: Team = {
      ...team,
      orchestratorId: parsed.orchestratorHandle ? byHandle.get(parsed.orchestratorHandle)?.id : agents[0]?.id,
      defaultAgentId: parsed.defaultAgentHandle ? byHandle.get(parsed.defaultAgentHandle)?.id : undefined,
      updatedAt: new Date(),
    };
    await this.deps.storage.teams.update(updated);
    await this.syncTeamFile(team.id);
    this.emit({ type: 'team.changed', teamId: team.id });

    return { team: { ...updated, agents }, warnings: parsed.warnings };
  }

  /* ================================================================ *
   * Agents
   * ================================================================ */

  async listAgents(teamId?: string): Promise<Agent[]> {
    return teamId
      ? this.deps.storage.agents.listByTeam(teamId)
      : this.deps.storage.agents.listAll();
  }

  async getAgent(agentId: string): Promise<Agent> {
    const agent = await this.deps.storage.agents.get(agentId);
    if (!agent) throw notFound('Agent', agentId);
    return agent;
  }

  async createAgent(input: unknown): Promise<Agent> {
    const parsed = createAgentSchema.parse(input);
    const team = await this.deps.storage.teams.get(parsed.teamId);
    if (!team) throw notFound('Team', parsed.teamId);
    const existing = await this.deps.storage.agents.listByTeam(parsed.teamId);
    const settings = await this.getSettings();

    const agent = createAgentEntity(
      {
        ...parsed,
        model: parsed.model ?? settings.defaultModel,
        effort: parsed.effort ?? settings.defaultEffort,
        tools: parsed.tools ?? defaultToolPermissions(),
        workspace: parsed.workspace ? expandPath(parsed.workspace) : undefined,
        order: parsed.order ?? existing.length,
      },
      existing.map((a) => a.handle),
    );
    await this.deps.storage.agents.create(agent);

    // The first agent on a team becomes its orchestrator by default.
    if (existing.length === 0 && !team.orchestratorId) {
      await this.deps.storage.teams.update({
        ...team,
        orchestratorId: agent.id,
        defaultAgentId: agent.id,
        updatedAt: new Date(),
      });
      this.emit({ type: 'team.changed', teamId: team.id });
    }

    await this.syncTeamFile(agent.teamId);
    this.emit({ type: 'agent.changed', agentId: agent.id, teamId: agent.teamId });
    return agent;
  }

  async createAgentFromTemplate(input: {
    teamId: string;
    templateId: string;
    handle?: string;
    name?: string;
    model?: string;
    effort?: AgentEffort;
    canMessage?: string[];
  }): Promise<Agent> {
    const template = findTemplate(input.templateId);
    if (!template) throw notFound('Template', input.templateId);
    return this.createAgent({
      teamId: input.teamId,
      handle: input.handle ?? template.handle,
      name: input.name ?? template.name,
      role: template.role,
      description: template.description,
      systemPrompt: template.systemPrompt,
      model: input.model ?? template.model,
      effort: input.effort ?? template.effort,
      tools: template.tools.map((t) => ({ ...t })),
      communicationRules: template.communicationRules,
      canMessage: input.canMessage ?? ['*'],
      templateId: template.id,
    });
  }

  async updateAgent(agentId: string, patch: unknown): Promise<Agent> {
    const parsed = updateAgentSchema.parse(patch);
    const agent = await this.getAgent(agentId);
    const siblings = (await this.deps.storage.agents.listByTeam(agent.teamId)).filter(
      (a) => a.id !== agentId,
    );

    let handle = agent.handle;
    if (parsed.handle && parsed.handle !== agent.handle) {
      handle = uniqueSlug(parsed.handle, siblings.map((a) => a.handle));
    }

    if (parsed.canMessage) {
      const known = new Set([...siblings.map((a) => a.handle), '*']);
      const unknownHandle = parsed.canMessage.find((h) => !known.has(h));
      if (unknownHandle) throw invalid(`"${unknownHandle}" is not a teammate of this agent.`);
    }

    const next: Agent = {
      ...agent,
      name: parsed.name ?? agent.name,
      handle,
      role: parsed.role ?? agent.role,
      description: nullable(parsed.description, agent.description),
      systemPrompt: parsed.systemPrompt ?? agent.systemPrompt,
      model: parsed.model ?? agent.model,
      effort: parsed.effort ?? agent.effort,
      tools: parsed.tools ?? agent.tools,
      workspace:
        parsed.workspace === null
          ? undefined
          : parsed.workspace
            ? expandPath(parsed.workspace)
            : agent.workspace,
      context: parsed.context ?? agent.context,
      memory: {
        enabled: parsed.memory?.enabled ?? agent.memory.enabled,
        notes: parsed.memory?.notes ?? agent.memory.notes,
      },
      communicationRules: parsed.communicationRules ?? agent.communicationRules,
      canMessage: parsed.canMessage ?? agent.canMessage,
      limits: { ...agent.limits, ...(parsed.limits ?? {}) },
      status: parsed.status ?? agent.status,
      order: parsed.order ?? agent.order,
      metadata: parsed.metadata ? { ...agent.metadata, ...parsed.metadata } : agent.metadata,
      updatedAt: new Date(),
    };

    await this.deps.storage.agents.update(next);

    // Renaming an agent must not silently break teammates' routing rules.
    if (handle !== agent.handle) {
      for (const sibling of siblings) {
        if (!sibling.canMessage.includes(agent.handle)) continue;
        await this.deps.storage.agents.update({
          ...sibling,
          canMessage: sibling.canMessage.map((h) => (h === agent.handle ? handle : h)),
          updatedAt: new Date(),
        });
        this.emit({ type: 'agent.changed', agentId: sibling.id, teamId: sibling.teamId });
      }
    }

    await this.syncTeamFile(agent.teamId);
    this.emit({ type: 'agent.changed', agentId, teamId: agent.teamId });
    return next;
  }

  /** First-class shortcut: change one agent's model without touching anything else. */
  async updateAgentModel(agentId: string, model: string): Promise<Agent> {
    return this.updateAgent(agentId, { model });
  }

  /** First-class shortcut: change one agent's effort without touching anything else. */
  async updateAgentEffort(agentId: string, effort: AgentEffort): Promise<Agent> {
    return this.updateAgent(agentId, { effort });
  }

  async updateAgentTools(agentId: string, tools: ToolPermission[]): Promise<Agent> {
    return this.updateAgent(agentId, { tools });
  }

  async deleteAgent(agentId: string): Promise<void> {
    const agent = await this.getAgent(agentId);
    const team = await this.deps.storage.teams.get(agent.teamId);
    await this.deps.storage.agents.delete(agentId);

    if (team) {
      const patch: Partial<Team> = {};
      if (team.orchestratorId === agentId) patch.orchestratorId = undefined;
      if (team.defaultAgentId === agentId) patch.defaultAgentId = undefined;
      if (Object.keys(patch).length > 0) {
        const remaining = await this.deps.storage.agents.listByTeam(team.id);
        await this.deps.storage.teams.update({
          ...team,
          ...patch,
          orchestratorId: patch.orchestratorId === undefined && team.orchestratorId === agentId
            ? remaining[0]?.id
            : team.orchestratorId,
          updatedAt: new Date(),
        });
        this.emit({ type: 'team.changed', teamId: team.id });
      }
    }

    // Drop the deleted handle from every teammate's routing list.
    for (const sibling of await this.deps.storage.agents.listByTeam(agent.teamId)) {
      if (!sibling.canMessage.includes(agent.handle)) continue;
      await this.deps.storage.agents.update({
        ...sibling,
        canMessage: sibling.canMessage.filter((h) => h !== agent.handle),
        updatedAt: new Date(),
      });
    }

    await this.syncTeamFile(agent.teamId);
    this.emit({ type: 'agent.changed', agentId: null, teamId: agent.teamId });
  }

  async duplicateAgent(agentId: string, overrides: { name?: string; handle?: string } = {}): Promise<Agent> {
    const source = await this.getAgent(agentId);
    const siblings = await this.deps.storage.agents.listByTeam(source.teamId);
    const copy = cloneAgentEntity(source, overrides, siblings.map((a) => a.handle));
    copy.order = siblings.length;
    await this.deps.storage.agents.create(copy);
    await this.syncTeamFile(copy.teamId);
    this.emit({ type: 'agent.changed', agentId: copy.id, teamId: copy.teamId });
    return copy;
  }

  async inspectAgent(agentId: string, runId?: string): Promise<AgentInspection> {
    const agent = await this.getAgent(agentId);
    const team = await this.deps.storage.teams.get(agent.teamId);
    if (!team) throw notFound('Team', agent.teamId);

    const targetRunId = runId ?? (await this.latestRunIdForTeam(agent.teamId));
    const [messages, events, tasks] = await Promise.all([
      targetRunId
        ? this.deps.storage.messages.list({ runId: targetRunId })
        : Promise.resolve([] as AgentMessage[]),
      targetRunId
        ? this.deps.storage.events.list({ runId: targetRunId, agentId })
        : Promise.resolve([] as RunEvent[]),
      targetRunId ? this.deps.storage.tasks.listByRun(targetRunId) : Promise.resolve([] as Task[]),
    ]);

    const inbox = messages.filter((m) => m.to.includes(agentId));
    const siblings = (await this.deps.storage.agents.listByTeam(agent.teamId)).filter(
      (a) => a.id !== agentId,
    );

    return {
      agent,
      team,
      currentTask: tasks.find((t) => t.assignedAgentId === agentId && t.status === 'running'),
      messageCount: messages.filter((m) => m.from === agentId || m.to.includes(agentId)).length,
      unreadCount: inbox.filter((m) => m.status === 'pending').length,
      toolCalls: events.filter((e) => e.type === 'tool_call').length,
      runtimeMs: events.reduce((sum, e) => sum + (e.durationMs ?? 0), 0),
      activations: events.filter((e) => e.type === 'agent_started').length,
      lastEvents: events.slice(-50),
      inbox,
      reachable: siblings
        .filter((s) => agent.canMessage.includes('*') || agent.canMessage.includes(s.handle))
        .map((s) => s.handle),
    };
  }

  /* ================================================================ *
   * Runs
   * ================================================================ */

  async listRuns(filter: { teamId?: string; limit?: number } = {}): Promise<Run[]> {
    return this.deps.storage.runs.list({ teamId: filter.teamId, limit: filter.limit ?? 100 });
  }

  async getRun(runId: string): Promise<Run> {
    const run = await this.deps.storage.runs.get(runId);
    if (!run) throw notFound('Run', runId);
    return run;
  }

  /**
   * Creates a run and (unless told otherwise) starts it immediately.
   * Returns as soon as the engine is live — use `waitForRun` to block.
   */
  async startRun(input: unknown): Promise<Run> {
    const parsed = startRunSchema.parse(input);
    const workspace = await this.resolveWorkspace({
      requested: parsed.workspace,
      teamId: parsed.teamId,
    });
    await this.assertWorkspacesExist(parsed.teamId, workspace.path);
    const run = await this.runs.createRun({
      teamId: parsed.teamId,
      objective: parsed.objective,
      // A team with no budget at all means "whatever the application says",
      // not "no limits": without this a team whose budget was cleared would
      // run with nothing to stop it, which is never what clearing a field
      // means. Choosing to run unmetered is a different thing, and it still
      // carries the time and interaction limits.
      budget: parsed.budget ?? (await this.budgetForTeam(parsed.teamId)),
      // Resolved here rather than left to the run manager's `?? team.workspace`,
      // so the directory the command was called from wins.
      workspace: workspace.path,
    });
    this.emit({ type: 'run.created', run });

    if (parsed.autoStart === false) return run;
    return this.runs.start(run.id);
  }

  /** The team's own budget, or the application default when it has none. */
  private async budgetForTeam(teamId: string): Promise<Budget | undefined> {
    const team = await this.deps.storage.teams.get(teamId);
    if (team?.budget) return team.budget;
    return (await this.getSettings()).defaultBudget;
  }

  /**
   * Every agent is spawned with its working directory as the process `cwd`.
   * A directory that does not exist makes the spawn fail deep inside the
   * provider, where the error is reported as a binary/libc problem — which
   * sends people looking in entirely the wrong place. Check it up front and
   * say plainly what is wrong.
   */
  private async assertWorkspacesExist(teamId: string, runWorkspace?: string): Promise<void> {
    const team = await this.deps.storage.teams.get(teamId);
    if (!team) throw notFound('Team', teamId);
    const agents = await this.deps.storage.agents.listByTeam(teamId);

    const teamWorkspace = runWorkspace ?? team.workspace;
    const targets: Array<{ path: string; owner: string }> = [];
    if (teamWorkspace) targets.push({ path: teamWorkspace, owner: `team "${team.name}"` });
    for (const agent of agents) {
      if (agent.workspace) targets.push({ path: agent.workspace, owner: `agent "${agent.handle}"` });
    }

    for (const target of targets) {
      const info = await inspectWorkspace(target.path);
      if (!info.exists) {
        throw invalid(
          `The workspace for ${target.owner} does not exist: ${info.path}. ` +
            'Create the directory, or point the workspace somewhere else before starting a run.',
          { path: info.path, owner: target.owner },
        );
      }
      if (!info.isDirectory) {
        throw invalid(
          `The workspace for ${target.owner} is not a directory: ${info.path}.`,
          { path: info.path, owner: target.owner },
        );
      }
    }
  }

  /** Starts a run that was created queued (`autoStart: false`). */
  async startQueuedRun(runId: string): Promise<Run> {
    const queued = await this.getRun(runId);
    await this.assertWorkspacesExist(queued.teamId, queued.workspace);
    const run = await this.runs.start(runId);
    this.emit({ type: 'run.status', runId, status: run.status, run });
    return run;
  }

  async waitForRun(runId: string): Promise<Run> {
    return this.runs.waitFor(runId);
  }

  async pauseRun(runId: string): Promise<Run> {
    const run = await this.runs.pause(runId);
    this.emit({ type: 'run.status', runId, status: run.status, run });
    return run;
  }

  async resumeRun(runId: string): Promise<Run> {
    const run = await this.runs.resume(runId);
    this.emit({ type: 'run.status', runId, status: run.status, run });
    return run;
  }

  async cancelRun(runId: string): Promise<Run> {
    const run = await this.runs.cancel(runId);
    this.emit({ type: 'run.status', runId, status: run.status, run });
    return run;
  }

  /**
   * Changes the limits of one run.
   *
   * A run's budget is a snapshot from when it started, so raising the team's
   * budget deliberately does not touch it. This is how you give an existing run
   * more room — including a finished one, so its agents can answer questions
   * again after it hit a cap.
   */
  async updateRunBudget(runId: string, input: unknown): Promise<Run> {
    const budget = input === null ? undefined : budgetSchema.parse(input);
    const run = await this.runs.setBudget(runId, budget);
    this.emit({ type: 'run.status', runId, status: run.status, run });
    return run;
  }

  /**
   * Removes a run and everything under it: tasks, messages, timeline,
   * approvals and questions.
   *
   * Refused while the run is executing here, for the same reason deleting a
   * team with a live run is refused — the engine is holding rows this would
   * pull out from under it. Cancel first. A run left `paused` by a restart is
   * not executing, so it can be deleted; that is usually exactly what someone
   * clearing out old runs wants.
   */
  async deleteRun(runId: string): Promise<void> {
    await this.getRun(runId);
    if (this.runs.isActive(runId)) {
      throw illegalState('This run is still executing. Cancel it before deleting it.');
    }
    await this.deps.storage.runs.delete(runId);
    this.emit({ type: 'run.deleted', runId });
  }

  /** Creates a fresh run with the same objective, and starts it. */
  async retryRun(runId: string): Promise<Run> {
    const previous = await this.getRun(runId);
    await this.assertWorkspacesExist(previous.teamId, previous.workspace);
    const created = await this.runs.retry(runId);
    this.emit({ type: 'run.created', run: created });
    return this.runs.start(created.id);
  }

  async getRunDetail(runId: string): Promise<RunDetail> {
    const run = await this.getRun(runId);
    const [team, agents, tasks, messages, events, approvals, questions] = await Promise.all([
      this.deps.storage.teams.get(run.teamId),
      this.deps.storage.agents.listByTeam(run.teamId),
      this.deps.storage.tasks.listByRun(runId),
      this.deps.storage.messages.list({ runId }),
      this.deps.storage.events.list({ runId }),
      this.deps.storage.approvals.list({ runId }),
      this.deps.storage.questions.list({ runId }),
    ]);
    if (!team) throw notFound('Team', run.teamId);

    return {
      run,
      team,
      agents,
      tasks,
      messages,
      events,
      approvals,
      questions,
      progress: taskProgress(tasks),
      isActive: this.runs.isActive(runId),
    };
  }

  /**
   * The whole run as a single document — objective, per-agent configuration,
   * task board, conversation, timeline and result.
   *
   * Rendered in the core so the text the TUI copies and the file the browser
   * downloads are the same artefact.
   */
  async exportRun(
    runId: string,
    options: TranscriptOptions = {},
  ): Promise<{ content: string; fileName: string; mimeType: string; format: TranscriptFormat }> {
    const detail = await this.getRunDetail(runId);
    const format = options.format ?? 'markdown';
    return {
      content: formatTranscript(detail, { ...options, format }),
      fileName: transcriptFileName(detail.run, format),
      mimeType: transcriptMimeType(format),
      format,
    };
  }

  async listRunEvents(runId: string, afterSeq = 0, limit = 500): Promise<RunEvent[]> {
    return this.deps.storage.events.list({ runId, afterSeq, limit });
  }

  async listTasks(runId: string): Promise<Task[]> {
    return this.deps.storage.tasks.listByRun(runId);
  }

  /* ================================================================ *
   * Messages
   * ================================================================ */

  async listMessages(runId: string): Promise<AgentMessage[]> {
    return this.deps.storage.messages.list({ runId });
  }

  async agentInbox(runId: string, agentId: string): Promise<AgentMessage[]> {
    return this.deps.storage.messages.list({ runId, toParticipant: agentId });
  }

  /**
   * Injects a message into a run's bus. Used both by the human writing to an
   * agent from either UI, and by tests.
   */
  async sendAgentMessage(input: unknown): Promise<AgentMessage> {
    const parsed = sendAgentMessageSchema.parse(input);
    const run = await this.getRun(parsed.runId);
    const agents = await this.deps.storage.agents.listByTeam(run.teamId);

    const resolve = (ref: string): string => {
      if (ref === 'user') return 'user';
      const agent =
        agents.find((a) => a.id === ref) ??
        agents.find((a) => a.handle === ref) ??
        agents.find((a) => a.name.toLowerCase() === ref.toLowerCase());
      if (!agent) throw notFound('Agent', ref);
      return agent.id;
    };

    const from = resolve(parsed.from);
    const to = parsed.to.map(resolve);

    // Refused before the message is stored, not after: a message that no agent
    // can answer used to be saved, reported as delivered, and then answered by
    // nobody — which is indistinguishable from the product being broken. The
    // message names the fix, because raising the *team* budget does nothing for
    // a run that already has its own.
    if (from === 'user' && to.some((id) => id !== 'user')) {
      const spent = spendExhausted(run.budget, run.totals);
      if (spent) {
        throw new DomainError(
          'budget_exceeded',
          `${budgetStop(run.budget, { totals: run.totals }, 'spend')} An agent cannot answer until this run's own budget is raised — team and application budgets do not apply to a run that already started.`,
          { runId: run.id, budget: run.budget, totals: run.totals },
        );
      }
    }

    const seq = await this.deps.storage.messages.nextSeq(parsed.runId);
    const message = createMessageEntity({
      runId: parsed.runId,
      seq,
      from,
      to,
      type: parsed.type,
      content: parsed.content,
      replyTo: parsed.replyTo,
      taskId: parsed.taskId,
      hop: 0,
      path: [from],
    });
    await this.deps.storage.messages.create(message);

    const seqEvent = await this.deps.storage.events.nextSeq(parsed.runId);
    const handle = (id: string) =>
      id === 'user' ? 'user' : (agents.find((a) => a.id === id)?.handle ?? id);
    const event = createEventEntity({
      runId: parsed.runId,
      seq: seqEvent,
      type: 'message_sent',
      agentId: from === 'user' ? undefined : from,
      messageId: message.id,
      summary: `${handle(from)} → ${to.map(handle).join(', ')}: ${message.content.split('\n')[0]}`,
      data: { type: message.type, manual: true },
    });
    await this.deps.storage.events.append(event);

    this.emit({ type: 'message', message });
    this.emit({ type: 'run.event', runId: parsed.runId, event });

    // A message from the human is a question, and a question that nothing
    // answers is just a row in a table. Hand it to the agents so they reply —
    // reopening the run if it has already finished, which is when people
    // usually want to ask something.
    const recipients = to.filter((id) => id !== 'user');
    if (from === 'user' && recipients.length > 0) {
      void this.runs
        .replyToHuman(parsed.runId, recipients, message)
        .catch((err) => {
          const e = toDomainError(err);
          this.emit({
            type: 'notice',
            level: 'error',
            message: `Could not get an answer: ${e.message}`,
          });
        });
    }

    return message;
  }

  /**
   * Resolves once the agents have finished answering your message.
   *
   * The UIs do not wait — the answer arrives as an event like everything else —
   * but a caller that needs the reply in hand (a test, a script) can.
   */
  async waitForReply(runId: string): Promise<void> {
    // Settles rather than propagates: a failure to answer is already recorded
    // on the run as an error event, and the message is marked failed, so a
    // caller waiting for the exchange to finish should read those rather than
    // catch an exception here.
    await this.runs.pendingReply(runId)?.catch(() => {});
  }

  /* ================================================================ *
   * Approvals
   * ================================================================ */

  /**
   * Approvals actually waiting for a human right now.
   *
   * A persisted `pending` row only means something while its run is still
   * executing in this process — a request left behind by a killed process can
   * never be answered, so surfacing it would give the UIs a prompt that does
   * nothing. Those rows are expired on startup; this filter is the second line
   * of defence.
   */
  async listPendingApprovals(runId?: string): Promise<ApprovalRequest[]> {
    const live = this.runs.pendingApprovals(runId);
    if (live.length > 0) return live;
    const active = new Set(this.runs.activeRunIds());
    const stored = await this.deps.storage.approvals.list({ runId, status: 'pending' });
    return stored.filter((a) => active.has(a.runId));
  }

  async resolveApproval(input: unknown): Promise<{ ok: boolean }> {
    const parsed = approvalDecisionSchema.parse(input);
    const approval = await this.deps.storage.approvals.get(parsed.approvalId);
    if (!approval) throw notFound('Approval', parsed.approvalId);
    const ok = this.runs.resolveApproval(
      approval.runId,
      parsed.approvalId,
      parsed.decision,
      parsed.decidedBy,
    );
    if (!ok) {
      throw illegalState('This approval is no longer waiting for a decision.');
    }
    return { ok };
  }

  /* ================================================================ *
   * Questions to the human
   * ================================================================ */

  /**
   * Questions actually waiting for an answer. Like approvals, a row left
   * `pending` by a dead process can never be answered, so only questions whose
   * run is live are surfaced.
   */
  async listPendingQuestions(runId?: string): Promise<AgentQuestion[]> {
    const live = this.runs.pendingQuestions(runId);
    if (live.length > 0) return live;
    const active = new Set(this.runs.activeRunIds());
    const stored = await this.deps.storage.questions.list({ runId, status: 'pending' });
    return stored.filter((q) => active.has(q.runId));
  }

  async listQuestions(runId: string): Promise<AgentQuestion[]> {
    return this.deps.storage.questions.list({ runId });
  }

  /**
   * Answers an agent's question. `selected` are labels picked from the offered
   * options; `text` is free-form. Either or both may be given — the agent
   * receives them as one piece of text.
   */
  async answerQuestion(input: unknown): Promise<{ ok: boolean }> {
    const parsed = answerQuestionSchema.parse(input);
    const question = await this.deps.storage.questions.get(parsed.questionId);
    if (!question) throw notFound('Question', parsed.questionId);

    const selected = parsed.selected ?? [];
    if (selected.length > 1 && !question.allowMultiple) {
      throw invalid('This question accepts a single choice.');
    }
    const offered = new Set(question.options.map((o) => o.label));
    const unknownChoice = selected.find((label) => !offered.has(label));
    if (unknownChoice) {
      throw invalid(`"${unknownChoice}" is not one of the offered options.`, {
        options: [...offered],
      });
    }
    const freeform = parsed.text?.trim() ?? '';
    if (selected.length === 0 && !freeform) {
      throw invalid('Pick an option or type an answer.');
    }
    if (!freeform && selected.length === 0) throw invalid('Pick an option or type an answer.');
    if (freeform && !question.allowFreeform && selected.length === 0) {
      throw invalid('This question expects you to pick one of the offered options.');
    }

    const answer = [
      selected.length ? `Chosen: ${selected.join(', ')}` : '',
      freeform,
    ]
      .filter(Boolean)
      .join('\n\n');

    const ok = this.runs.answerQuestion(
      question.runId,
      question.id,
      answer,
      parsed.answeredBy ?? 'user',
    );
    if (!ok) throw illegalState('This question is no longer waiting for an answer.');
    return { ok };
  }

  /* ================================================================ *
   * Activity, search, dashboard
   * ================================================================ */

  async recentActivity(limit = 100): Promise<RunEvent[]> {
    return this.deps.storage.events.recent(limit);
  }

  async search(query: string, limit = 50): Promise<SearchHit[]> {
    return search(this.deps.storage, query, limit);
  }

  async getDashboard(): Promise<DashboardView> {
    const [teams, runs, recentEvents, settings] = await Promise.all([
      this.listTeams(),
      this.deps.storage.runs.list({ limit: 50 }),
      this.recentActivity(50),
      this.getSettings(),
    ]);

    const activeIds = new Set(this.runs.activeRunIds());
    const activeRuns = runs.filter((r) => activeIds.has(r.id) || r.status === 'running');
    const agents = teams.flatMap((t) => t.agents);

    // Progress for the runs the dashboard will actually draw a bar for, so no
    // surface has to make an extra round trip per run.
    const progress: Record<string, ReturnType<typeof taskProgress>> = {};
    for (const run of activeRuns) {
      progress[run.id] = taskProgress(await this.deps.storage.tasks.listByRun(run.id));
    }

    return {
      progress,
      teams: teams.map((team) => ({
        ...team,
        activeRunId: activeRuns.find((r) => r.teamId === team.id)?.id,
      })),
      activeRuns,
      recentRuns: runs.slice(0, 10),
      recentEvents,
      pendingApprovals: await this.listPendingApprovals(),
      pendingQuestions: await this.listPendingQuestions(),
      counts: {
        teams: teams.length,
        agents: agents.length,
        runs: runs.length,
        runningAgents: agents.filter((a) => a.status !== 'idle').length,
      },
      settings,
    };
  }

  async inspectWorkspace(path: string): Promise<WorkspaceInfo & { summary?: string }> {
    const info = await inspectWorkspace(path);
    return { ...info, summary: describeGit(info) };
  }

  private async latestRunIdForTeam(teamId: string): Promise<string | undefined> {
    const runs = await this.deps.storage.runs.list({ teamId, limit: 1 });
    return runs[0]?.id;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function nullable<T>(value: T | null | undefined, current: T | undefined): T | undefined {
  if (value === null) return undefined;
  if (value === undefined) return current;
  return value;
}

function stripUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefinedDeep) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefinedDeep(v);
    }
    return out as T;
  }
  return value;
}

export type { AgentStatus, SearchHit };
