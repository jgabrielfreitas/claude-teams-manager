import {
  DomainError,
  assertRunTransition,
  createRun,
  illegalState,
  notFound,
  type AgentConfigSnapshot,
  type AgentMessage,
  type ApprovalDecision,
  type Budget,
  type Run,
} from '@claude-team/domain';
import { RunEngine } from './run-engine.js';
import { EventRecorder } from './recorder.js';
import { DEFAULT_ENGINE_OPTIONS, type RunContext, type RunEngineOptions, type RuntimeDeps } from './types.js';

/**
 * Owns the set of live runs.
 *
 * The engine executes one run; the manager decides which runs exist, keeps
 * exactly one engine per run, and provides the pause/resume/cancel surface the
 * UIs call. Both the TUI and the web server talk to the same instance through
 * the application core, so a run started in one is controllable from the other.
 */
export class RunManager {
  private readonly engines = new Map<string, RunEngine>();
  private readonly running = new Map<string, Promise<Run>>();
  /** Answers being written for runs that are not otherwise executing. */
  private readonly replying = new Map<string, Promise<void>>();
  private readonly recorder: EventRecorder;

  constructor(
    private readonly deps: RuntimeDeps,
    private options: RunEngineOptions = DEFAULT_ENGINE_OPTIONS,
  ) {
    this.recorder = new EventRecorder(deps.storage, deps.onEvent, deps.clock);
  }

  setOptions(options: Partial<RunEngineOptions>): void {
    this.options = { ...this.options, ...options };
  }

  getOptions(): RunEngineOptions {
    return this.options;
  }

  isActive(runId: string): boolean {
    return this.engines.has(runId);
  }

  activeRunIds(): string[] {
    return [...this.engines.keys()];
  }

  /** Creates a run record without starting it. */
  async createRun(input: {
    teamId: string;
    objective: string;
    budget?: Budget;
    workspace?: string;
    retryOfRunId?: string;
  }): Promise<Run> {
    const team = await this.deps.storage.teams.get(input.teamId);
    if (!team) throw notFound('Team', input.teamId);
    const agents = await this.deps.storage.agents.listByTeam(team.id);
    if (agents.length === 0) {
      throw illegalState('This team has no agents yet. Add at least one before starting a run.');
    }

    const orchestrator = this.pickOrchestrator(team.orchestratorId, agents);

    const snapshot: AgentConfigSnapshot[] = agents.map((a) => ({
      agentId: a.id,
      handle: a.handle,
      name: a.name,
      role: a.role,
      model: a.model,
      effort: a.effort,
      isOrchestrator: a.id === orchestrator.id,
    }));

    const run = createRun({
      teamId: team.id,
      objective: input.objective,
      budget: input.budget ?? team.budget,
      workspace: input.workspace ?? team.workspace,
      agentConfigSnapshot: snapshot,
      retryOfRunId: input.retryOfRunId,
    });

    await this.deps.storage.runs.create(run);
    await this.recorder.record({
      runId: run.id,
      type: 'run_created',
      summary: `Run queued for "${team.name}": ${run.objective.split('\n')[0]}`,
      data: { objective: run.objective, agents: snapshot },
    });
    return run;
  }

  /**
   * Starts (or resumes) a run. Returns as soon as the engine is live; the
   * promise for the finished run is available through `waitFor`.
   */
  async start(runId: string): Promise<Run> {
    const run = await this.deps.storage.runs.get(runId);
    if (!run) throw notFound('Run', runId);
    // Checked before the engine lookup: a terminal run may still have an engine
    // attached while an agent answers a message, and that must never be
    // mistaken for a run that can be resumed.
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw illegalState(`This run already ${run.status}. Retry it to run again.`);
    }

    const existing = this.engines.get(runId);
    if (existing) {
      existing.resume();
      return (await this.deps.storage.runs.get(runId))!;
    }

    const ctx = await this.loadContext(run);

    // Flip to `running` before handing off to the engine, so the caller (and
    // therefore the HTTP response and the UI that triggered it) sees the real
    // state rather than the `queued` value the engine has not overwritten yet.
    const started: Run =
      run.status === 'running'
        ? run
        : {
            ...run,
            status: 'running',
            startedAt: run.startedAt ?? new Date(),
            updatedAt: new Date(),
          };
    if (started !== run) {
      assertRunTransition(run.status, 'running');
      await this.deps.storage.runs.update(started);
      this.deps.onRunStatus?.(runId, 'running');
    }

    const engine = new RunEngine(this.deps, started, ctx, this.options);
    this.engines.set(runId, engine);

    const promise = engine
      .start()
      .catch((err) => {
        // `start` already records and persists failure; this is a last resort.
        return (
          this.deps.storage.runs.get(runId).then((r) => {
            if (r) return r;
            throw err;
          }) as Promise<Run>
        );
      })
      .finally(() => {
        this.engines.delete(runId);
        this.running.delete(runId);
      });

    this.running.set(runId, promise);
    return (await this.deps.storage.runs.get(runId))!;
  }

  /**
   * Delivers a message the human wrote to one or more agents, and has them
   * answer it.
   *
   * Works whether or not the run is still going. When it is, the live engine
   * handles it and the activation queues behind whatever that agent is already
   * doing. When it is not — the common case, because people read a result and
   * then want to ask about it — an engine is attached for exactly as long as
   * the answer takes. It restores each agent's provider session, so the agent
   * answers still knowing the run rather than from a blank slate, and the run's
   * own state is not touched: a finished run stays finished.
   *
   * Returns once every addressed agent has answered, so the caller can decide
   * whether to wait; `AppCore` does not, and lets the answers arrive as events.
   */
  replyToHuman(runId: string, agentIds: string[], message: AgentMessage): Promise<void> {
    // Registered synchronously, before the first `await`: a caller that wants to
    // wait for the answer asks for it immediately after sending, and a promise
    // published one tick late is a promise nobody can wait on.
    const previous = this.replying.get(runId);

    // The closure below reads `promise`, which is fine: it only runs once the
    // promise it is attached to has settled, long after this assignment.
    const promise: Promise<void> = (async () => {
      // One answer at a time per run: two engines on the same run would both
      // write totals and both think they own the agents' sessions.
      if (previous) await previous.catch(() => {});

      const live = this.engines.get(runId);
      if (live) {
        for (const agentId of agentIds) await live.replyToHuman(agentId, message);
        return;
      }

      const run = await this.requireRun(runId);
      const ctx = await this.loadContext(run);
      const engine = new RunEngine(this.deps, run, ctx, this.options);
      // Registered as an engine on purpose: while an agent is composing an
      // answer the run really is doing something, so approvals it raises can be
      // answered and deleting it is refused.
      this.engines.set(runId, engine);
      try {
        for (const agentId of agentIds) await engine.replyToHuman(agentId, message);
      } finally {
        this.engines.delete(runId);
      }
    })().finally(() => {
      if (this.replying.get(runId) === promise) this.replying.delete(runId);
    });

    this.replying.set(runId, promise);
    return promise;
  }

  /** The answer currently being written for this run, if any. */
  pendingReply(runId: string): Promise<void> | undefined {
    return this.replying.get(runId);
  }

  /** Resolves when the run reaches a terminal state. */
  async waitFor(runId: string): Promise<Run> {
    const promise = this.running.get(runId);
    if (promise) return promise;
    const run = await this.deps.storage.runs.get(runId);
    if (!run) throw notFound('Run', runId);
    return run;
  }

  async pause(runId: string): Promise<Run> {
    const run = await this.requireRun(runId);
    assertRunTransition(run.status, 'paused');
    const engine = this.engines.get(runId);
    if (!engine) {
      // Not executing here (e.g. queued): record the intent so it does not start.
      const paused: Run = { ...run, status: 'paused', updatedAt: new Date() };
      await this.deps.storage.runs.update(paused);
      return paused;
    }
    engine.pause();
    // Pausing takes effect at the next safe point, so the run legitimately
    // stays "running" for a moment. Record the intent immediately so the UIs
    // can show that the request landed rather than looking unresponsive.
    await this.recorder.record({
      runId,
      type: 'log',
      level: 'warn',
      summary: 'Pause requested — it takes effect once the current agent activations finish.',
      data: { pauseRequested: true },
    });
    return (await this.deps.storage.runs.get(runId))!;
  }

  async resume(runId: string): Promise<Run> {
    const run = await this.requireRun(runId);
    if (run.status !== 'paused') {
      throw illegalState(`Only a paused run can be resumed (this one is "${run.status}").`);
    }
    const engine = this.engines.get(runId);
    if (engine) {
      engine.resume();
      return (await this.deps.storage.runs.get(runId))!;
    }
    // The engine is gone (process restarted): start a fresh one, which picks
    // the run back up from its persisted tasks, messages and sessions.
    return this.start(runId);
  }

  async cancel(runId: string): Promise<Run> {
    const run = await this.requireRun(runId);
    const engine = this.engines.get(runId);
    if (engine) {
      await engine.cancel();
      await this.waitFor(runId).catch(() => undefined);
      return (await this.deps.storage.runs.get(runId))!;
    }
    assertRunTransition(run.status, 'cancelled');
    const cancelled: Run = {
      ...run,
      status: 'cancelled',
      completedAt: new Date(),
      updatedAt: new Date(),
      error: 'Cancelled before it started.',
    };
    await this.deps.storage.runs.update(cancelled);
    await this.recorder.record({
      runId,
      type: 'run_cancelled',
      level: 'warn',
      summary: 'Run cancelled.',
      data: {},
    });
    return cancelled;
  }

  /** Creates a new run with the same objective and team as an old one. */
  async retry(runId: string): Promise<Run> {
    const run = await this.requireRun(runId);
    return this.createRun({
      teamId: run.teamId,
      objective: run.objective,
      budget: run.budget,
      workspace: run.workspace,
      retryOfRunId: run.id,
    });
  }

  resolveApproval(runId: string, approvalId: string, decision: ApprovalDecision, by?: string): boolean {
    return this.engines.get(runId)?.resolveApproval(approvalId, decision, by) ?? false;
  }

  answerQuestion(runId: string, questionId: string, answer: string, by?: string): boolean {
    return this.engines.get(runId)?.answerQuestion(questionId, answer, by) ?? false;
  }

  pendingQuestions(runId?: string) {
    if (runId) return this.engines.get(runId)?.pendingQuestions() ?? [];
    return [...this.engines.values()].flatMap((e) => e.pendingQuestions());
  }

  pendingApprovals(runId?: string) {
    if (runId) return this.engines.get(runId)?.pendingApprovals() ?? [];
    return [...this.engines.values()].flatMap((e) => e.pendingApprovals());
  }

  /**
   * Marks runs that a previous process left mid-flight as paused, so history is
   * preserved and the human can resume or cancel them deliberately.
   */
  async recoverInterrupted(): Promise<Run[]> {
    const interrupted = await this.deps.storage.runs.listInterrupted();
    const recovered: Run[] = [];
    for (const run of interrupted) {
      if (this.engines.has(run.id)) continue;
      const paused: Run = {
        ...run,
        status: 'paused',
        updatedAt: new Date(),
        error: run.error ?? 'Interrupted by an application restart.',
      };
      await this.deps.storage.runs.update(paused);
      await this.recorder.record({
        runId: run.id,
        type: 'run_paused',
        level: 'warn',
        summary: 'Run was interrupted by an application restart and is now paused.',
        data: {},
      });
      // An approval request from a dead process can never be answered: the
      // agent that was waiting on it no longer exists. Expire it so the UIs do
      // not show a prompt that does nothing.
      for (const approval of await this.deps.storage.approvals.list({
        runId: run.id,
        status: 'pending',
      })) {
        await this.deps.storage.approvals.update({
          ...approval,
          status: 'expired',
          resolvedAt: new Date(),
        });
      }

      recovered.push(paused);
    }
    await this.deps.storage.agents.resetStatuses();
    return recovered;
  }

  /** Stops every live run; used when the process is shutting down. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.engines.values()].map((e) => e.cancel()));
    await Promise.allSettled([...this.running.values()]);
  }

  private async requireRun(runId: string): Promise<Run> {
    const run = await this.deps.storage.runs.get(runId);
    if (!run) throw notFound('Run', runId);
    return run;
  }

  private async loadContext(run: Run): Promise<RunContext> {
    const team = await this.deps.storage.teams.get(run.teamId);
    if (!team) throw notFound('Team', run.teamId);
    const agents = await this.deps.storage.agents.listByTeam(team.id);
    if (agents.length === 0) throw illegalState('This team has no agents.');
    const orchestrator = this.pickOrchestrator(team.orchestratorId, agents);
    return {
      team,
      agents,
      orchestrator,
      workspace: run.workspace ?? team.workspace,
    };
  }

  private pickOrchestrator(orchestratorId: string | undefined, agents: RunContext['agents']) {
    const explicit = orchestratorId ? agents.find((a) => a.id === orchestratorId) : undefined;
    if (explicit) return explicit;
    const fallback = [...agents].sort((a, b) => a.order - b.order)[0];
    if (!fallback) {
      throw new DomainError('illegal_state', 'This team has no agent that could orchestrate.');
    }
    return fallback;
  }
}
