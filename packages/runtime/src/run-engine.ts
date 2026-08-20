import {
  DomainError,
  allTasksSettled,
  assertNoCycle,
  categoryForGroup,
  createTask,
  emptyUsage,
  isRunTerminal,
  isTaskTerminal,
  notFound,
  readyTasks,
  recomputeTaskStatuses,
  toDomainError,
  type Agent,
  type AgentMessage,
  type AgentStatus,
  type ApprovalDecision,
  type Budget,
  type BudgetScope,
  type Run,
  type RunStatus,
  type Task,
  type TaskStatus,
  type ToolPermission,
} from '@claude-team/domain';
import { approvalCategoryFor, type AgentProvider } from '@claude-team/provider';
import type { Storage } from '@claude-team/persistence';
import { ApprovalGate } from './approvals.js';
import { QuestionGate } from './questions.js';
import { BudgetTracker } from './budget.js';
import { MessageBus, Mutex } from './message-bus.js';
import { EventRecorder } from './recorder.js';
import {
  buildAnswerPrompt,
  buildHumanMessagePrompt,
  buildOrchestratorPrompt,
  buildReviewPrompt,
  buildSystemPrompt,
  buildTaskPrompt,
  renderTaskBoard,
} from './prompt.js';
import { buildToolSpecs, type TaskSpecInput, type ToolHost } from './tools.js';
import type { ActivationResult, RunContext, RunEngineOptions, RuntimeDeps } from './types.js';

/**
 * Executes one run from objective to result (ADR-002).
 *
 * The loop is: activate the orchestrator, let it plan through real tools, then
 * dispatch every task the dependency graph says is ready — in parallel, each
 * with its own agent's model and effort — until the graph stalls. Then hand
 * control back to the orchestrator with the updated board. Repeat until it
 * calls `finish`, the budget runs out, or the human stops it.
 */
export class RunEngine implements ToolHost {
  private run: Run;
  private tasks: Task[] = [];
  private readonly agents: Agent[];

  private readonly recorder: EventRecorder;
  private readonly bus: MessageBus;
  private readonly gate: ApprovalGate;
  private readonly questions: QuestionGate;
  private readonly budget: BudgetTracker;

  private readonly abort = new AbortController();
  private readonly agentLocks = new Map<string, Mutex>();
  private readonly sessions = new Map<string, string>();
  /** Chain state of the activation an agent is currently inside. */
  private readonly activationChains = new Map<string, { hop: number; path: string[]; depth: number }>();
  private activeSlots = 0;
  private readonly slotWaiters: Array<() => void> = [];

  private pauseRequested = false;
  private pauseGate?: { promise: Promise<void>; release: () => void };
  private finishSummary?: string;
  private finishRefused = false;
  private cancelled = false;
  private lastOrchestratorMessageSeq = 0;
  private readonly runtimeNotes: string[] = [];
  private settled = false;

  constructor(
    private readonly deps: RuntimeDeps,
    run: Run,
    private readonly ctx: RunContext,
    private readonly options: RunEngineOptions,
  ) {
    this.run = run;
    this.agents = [...ctx.agents];
    this.recorder = new EventRecorder(deps.storage, deps.onEvent, deps.clock);
    this.budget = new BudgetTracker(
      run.budget,
      run.startedAt?.getTime() ?? Date.now(),
      (message) => {
        void this.recorder.record({
          runId: run.id,
          type: 'budget_warning',
          summary: message,
          level: 'warn',
          data: { totals: this.budget.totals },
        });
      },
    );
    this.budget.restore(run.totals);

    this.gate = new ApprovalGate(run.id, deps.storage, this.recorder, {
      autoApproveAll: options.autoApproveAll,
      timeoutMs: options.approvalTimeoutMs,
      onApproval: deps.onApproval,
    });

    this.questions = new QuestionGate(run.id, deps.storage, this.recorder, {
      autoAnswer: options.autoAnswerQuestions,
      timeoutMs: options.questionTimeoutMs,
      onQuestion: deps.onQuestion,
    });

    this.bus = new MessageBus(
      run.id,
      deps.storage,
      this.recorder,
      this.agents,
      {
        maxHops: options.maxHops,
        maxRecursionDepth: options.maxRecursionDepth,
        maxMessagesPerRun: options.maxMessagesPerRun,
      },
      (recipient, message, chain) => this.answerAsk(recipient, message, chain),
      options.askTimeoutMs,
      () => this.budget.recordMessage(),
    );
  }

  get id(): string {
    return this.run.id;
  }

  get status(): RunStatus {
    return this.run.status;
  }

  get provider(): AgentProvider {
    return this.deps.provider;
  }

  get storage(): Storage {
    return this.deps.storage;
  }

  pendingApprovals() {
    return this.gate.listPending();
  }

  resolveApproval(approvalId: string, decision: ApprovalDecision, decidedBy?: string): boolean {
    return this.gate.resolve(approvalId, decision, decidedBy);
  }

  pendingQuestions() {
    return this.questions.listPending();
  }

  answerQuestion(questionId: string, answer: string, answeredBy?: string): boolean {
    return this.questions.answer(questionId, answer, answeredBy);
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  async start(): Promise<Run> {
    this.tasks = await this.deps.storage.tasks.listByRun(this.run.id);
    await this.restoreSessions();

    if (this.run.status === 'queued' || this.run.status === 'paused') {
      await this.setRunStatus('running');
    }
    if (!this.run.startedAt) {
      this.run = { ...this.run, startedAt: this.deps.clock?.() ?? new Date() };
      await this.persistRun();
    }

    await this.recorder.record({
      runId: this.run.id,
      type: 'run_started',
      summary: `Run started: ${firstLine(this.run.objective)}`,
      data: {
        objective: this.run.objective,
        team: this.ctx.team.name,
        agents: this.run.agentConfigSnapshot,
      },
    });

    try {
      await this.loop();
      await this.finalise();
    } catch (err) {
      const error = toDomainError(err);
      if (error.code === 'cancelled' || this.cancelled) {
        await this.terminate('cancelled', 'The run was cancelled.');
      } else {
        await this.recorder.record({
          runId: this.run.id,
          type: 'error',
          summary: `Run failed: ${error.message}`,
          level: 'error',
          data: error.toJSON(),
        });
        await this.terminate('failed', error.message);
      }
    } finally {
      await this.gate.abandonAll('The run ended.');
      await this.questions.abandonAll('The run ended before you answered.');
      await this.resetAgentStatuses();
    }

    return this.run;
  }

  /** Requests a pause. Takes effect at the next safe point. */
  pause(): void {
    if (this.run.status !== 'running') return;
    this.pauseRequested = true;
  }

  resume(): void {
    this.pauseRequested = false;
    this.pauseGate?.release();
    this.pauseGate = undefined;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.pauseRequested = false;
    this.pauseGate?.release();
    this.pauseGate = undefined;
    this.abort.abort();
    await this.gate.abandonAll('The run was cancelled.');
    await this.questions.abandonAll('The run was cancelled before you answered.');
  }

  private async loop(): Promise<void> {
    let idleRounds = 0;

    for (let round = 1; round <= this.options.maxRounds; round++) {
      await this.waitWhilePaused();
      if (this.cancelled) return;

      const budgetStop = this.budget.exceeded();
      if (budgetStop) {
        await this.recorder.record({
          runId: this.run.id,
          type: 'budget_exceeded',
          summary: budgetStop,
          level: 'error',
          data: { totals: this.budget.totals },
        });
        throw new DomainError('budget_exceeded', budgetStop);
      }

      const before = this.progressFingerprint();

      const newMessages = await this.messagesForOrchestrator();
      const prompt = buildOrchestratorPrompt({
        round,
        objective: this.run.objective,
        tasks: this.tasks,
        agents: this.agents,
        newMessages,
        notes: this.runtimeNotes.splice(0, this.runtimeNotes.length),
      });

      const result = await this.activate({
        agent: this.ctx.orchestrator,
        prompt,
        isOrchestrator: true,
        purpose: 'orchestrate',
      });

      if (this.cancelled) return;

      if (!result.ok) {
        this.runtimeNotes.push(
          `Your previous activation failed: ${result.error ?? 'unknown error'}. Try a smaller step.`,
        );
        if (round >= 2) throw new DomainError('agent_failed', result.error ?? 'The orchestrator failed.');
        continue;
      }

      if (this.finishSummary !== undefined) return;

      await this.drainTaskGraph();

      if (this.cancelled) return;
      if (this.finishSummary !== undefined) return;

      const after = this.progressFingerprint();
      if (after === before) {
        idleRounds += 1;
        this.runtimeNotes.push(
          'Nothing changed in the last round. Either create work, or call `finish` with what you have.',
        );
        if (idleRounds >= 2) {
          this.runtimeNotes.push('The run is stalling; it will be closed after this round.');
          await this.forceFinish(
            'The orchestrator stopped making progress. Closing the run with the work completed so far.',
          );
          return;
        }
      } else {
        idleRounds = 0;
      }
    }

    await this.forceFinish(
      `The run reached its limit of ${this.options.maxRounds} orchestration rounds.`,
    );
  }

  /**
   * Dispatches ready tasks until the dependency graph can produce no more.
   * Independent tasks run concurrently, each with its own agent's model
   * and effort.
   */
  private async drainTaskGraph(): Promise<void> {
    for (let guard = 0; guard < 200; guard++) {
      await this.waitWhilePaused();
      if (this.cancelled || this.finishSummary !== undefined) return;

      await this.syncTaskStatuses();
      const ready = readyTasks(this.tasks).filter((t) => t.assignedAgentId);

      const unassigned = readyTasks(this.tasks).filter((t) => !t.assignedAgentId);
      if (unassigned.length > 0) {
        this.runtimeNotes.push(
          `These tasks have no assignee and cannot run: ${unassigned.map((t) => t.title).join(', ')}.`,
        );
      }

      if (ready.length === 0) return;
      if (this.budget.exceeded()) return;

      await Promise.all(ready.map((task) => this.runTask(task)));
      if (allTasksSettled(this.tasks)) {
        await this.syncTaskStatuses();
        return;
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Task execution
   * ---------------------------------------------------------------- */

  private async runTask(task: Task): Promise<void> {
    const agent = this.agents.find((a) => a.id === task.assignedAgentId);
    if (!agent) {
      await this.updateTaskState(task, {
        status: 'failed',
        error: 'The assigned agent no longer exists.',
      });
      return;
    }

    await this.updateTaskState(task, {
      status: 'running',
      attempts: task.attempts + 1,
      startedAt: task.startedAt ?? new Date(),
    });
    await this.recorder.record({
      runId: this.run.id,
      type: 'task_started',
      taskId: task.id,
      agentId: agent.id,
      summary: `${agent.handle} started "${task.title}"`,
      data: { attempt: task.attempts },
    });

    const dependencies = task.dependencies
      .map((id) => this.tasks.find((t) => t.id === id))
      .filter(Boolean) as Task[];
    const inbox = await this.bus.pending(agent.id);
    await this.bus.markRead(inbox);

    const prompt = buildTaskPrompt({
      task,
      objective: this.run.objective,
      dependencies,
      inbox,
      agents: this.agents,
      attempt: task.attempts,
    });

    const result = await this.activate({
      agent,
      prompt,
      taskId: task.id,
      isOrchestrator: agent.id === this.ctx.orchestrator.id,
      purpose: 'task',
    });

    if (this.cancelled) {
      await this.updateTaskState(task, { status: 'cancelled', error: 'The run was cancelled.' });
      return;
    }

    if (!result.ok) {
      const canRetry = task.attempts < task.maxAttempts;
      await this.updateTaskState(task, {
        status: canRetry ? 'ready' : 'failed',
        error: result.error ?? 'The agent failed without a message.',
        completedAt: canRetry ? undefined : new Date(),
      });
      await this.recorder.record({
        runId: this.run.id,
        type: 'task_failed',
        taskId: task.id,
        agentId: agent.id,
        level: canRetry ? 'warn' : 'error',
        summary: canRetry
          ? `"${task.title}" failed (attempt ${task.attempts}/${task.maxAttempts}) — retrying`
          : `"${task.title}" failed permanently: ${result.error}`,
        data: { error: result.error, attempts: task.attempts },
      });
      if (!canRetry) {
        this.runtimeNotes.push(
          `Task "${task.title}" failed permanently: ${result.error}. Decide how to proceed.`,
        );
      }
      return;
    }

    if (task.reviewerAgentId) {
      await this.updateTaskState(task, { status: 'review', result: result.text });
      await this.recorder.record({
        runId: this.run.id,
        type: 'task_review_requested',
        taskId: task.id,
        agentId: task.reviewerAgentId,
        summary: `"${task.title}" is waiting for review`,
        data: {},
      });
      await this.reviewTask(task, agent);
      return;
    }

    await this.completeTask(task, result.text, agent);
  }

  private async completeTask(task: Task, result: string, agent: Agent): Promise<void> {
    await this.updateTaskState(task, {
      status: 'completed',
      result,
      error: undefined,
      completedAt: new Date(),
    });
    await this.recorder.record({
      runId: this.run.id,
      type: 'task_completed',
      taskId: task.id,
      agentId: agent.id,
      summary: `${agent.handle} completed "${task.title}"`,
      data: { result: truncate(result, 500) },
    });
    await this.syncTaskStatuses();
  }

  private async reviewTask(task: Task, author: Agent): Promise<void> {
    const reviewer = this.agents.find((a) => a.id === task.reviewerAgentId);
    if (!reviewer) {
      await this.completeTask(task, task.result ?? '', author);
      return;
    }

    const result = await this.activate({
      agent: reviewer,
      prompt: buildReviewPrompt({
        task,
        objective: this.run.objective,
        authorHandle: author.handle,
      }),
      taskId: task.id,
      isOrchestrator: false,
      purpose: 'review',
    });

    if (this.cancelled) return;

    // A reviewer that crashed must not block the run — but it must also not be
    // silently reported as an approval.
    if (!result.ok) {
      await this.completeTask(
        task,
        `${task.result ?? ''}\n\n---\nReview by ${reviewer.handle} could not be completed: ${result.error}. The work was accepted unreviewed.`,
        author,
      );
      this.runtimeNotes.push(
        `${reviewer.handle} failed to review "${task.title}" (${result.error}). The result is unverified.`,
      );
      return;
    }

    if (/VERDICT:\s*APPROVED/i.test(result.text)) {
      await this.completeTask(
        task,
        `${task.result ?? ''}\n\n---\nReview by ${reviewer.handle}: approved.`,
        author,
      );
      return;
    }

    const canRetry = task.attempts < task.maxAttempts;
    await this.updateTaskState(task, {
      status: canRetry ? 'ready' : 'failed',
      error: `Review by ${reviewer.handle} requested changes:\n${truncate(result.text, 2000)}`,
      completedAt: canRetry ? undefined : new Date(),
    });
    await this.recorder.record({
      runId: this.run.id,
      type: canRetry ? 'task_blocked' : 'task_failed',
      taskId: task.id,
      agentId: reviewer.id,
      level: 'warn',
      summary: `${reviewer.handle} requested changes on "${task.title}"`,
      data: { review: truncate(result.text, 1000), willRetry: canRetry },
    });
    if (!canRetry) {
      this.runtimeNotes.push(
        `Task "${task.title}" was rejected by ${reviewer.handle} and has no attempts left.`,
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * Agent activation
   * ---------------------------------------------------------------- */

  private async activate(opts: {
    agent: Agent;
    prompt: string;
    taskId?: string;
    isOrchestrator: boolean;
    purpose: 'orchestrate' | 'task' | 'review' | 'answer';
    chain?: { hop: number; path: string[]; depth: number };
    /** Which limits apply; see `BudgetScope`. Defaults to all of them. */
    budgetScope?: BudgetScope;
  }): Promise<ActivationResult> {
    const { agent } = opts;
    const budgetStop = this.budget.exceeded(Date.now(), opts.budgetScope);
    if (budgetStop) {
      return {
        ok: false,
        text: '',
        error: budgetStop,
        model: agent.model,
        effort: agent.effort,
        durationMs: 0,
      };
    }

    const releaseSlot = await this.acquireSlot();
    const releaseAgent = await this.lockFor(agent.id).acquire();
    const startedAt = Date.now();
    const activationId = `${this.run.id}:${agent.id}:${startedAt}:${Math.round(Math.random() * 1e6)}`;

    this.activationChains.set(agent.id, opts.chain ?? { hop: 0, path: [agent.id], depth: 0 });

    let text = '';
    let ok = false;
    let error: string | undefined;
    let costUsd: number | undefined;
    let usage = emptyUsage();

    try {
      await this.setAgentStatus(agent, 'thinking');
      await this.recorder.record({
        runId: this.run.id,
        type: 'agent_started',
        agentId: agent.id,
        taskId: opts.taskId,
        model: agent.model,
        effort: agent.effort,
        summary: `${agent.handle} started (${agent.model}, effort ${agent.effort})`,
        data: { purpose: opts.purpose, sessionId: this.sessions.get(agent.id) },
      });

      const reachable = this.agents
        .filter((a) => a.id !== agent.id)
        .filter((a) => agent.canMessage.includes('*') || agent.canMessage.includes(a.handle))
        .map((a) => a.handle);

      const messagingEnabled =
        agent.tools.find((t) => t.group === 'agent_messaging')?.mode !== 'deny';

      const customTools = buildToolSpecs({
        agent,
        host: this,
        isOrchestrator: opts.isOrchestrator,
        reachableHandles: reachable,
        messagingEnabled,
      });

      const systemPrompt = buildSystemPrompt({
        team: this.ctx.team,
        run: this.run,
        agent,
        agents: this.agents,
        orchestrator: this.ctx.orchestrator,
        workspace: agent.workspace ?? this.ctx.workspace,
        isOrchestrator: opts.isOrchestrator,
      });

      const stream = this.deps.provider.run({
        runId: this.run.id,
        activationId,
        agentId: agent.id,
        agentHandle: agent.handle,
        systemPrompt,
        prompt: opts.prompt,
        model: agent.model,
        effort: agent.effort,
        tools: this.effectiveTools(agent),
        customTools,
        cwd: agent.workspace ?? this.ctx.workspace,
        localSetup: this.options.localSetup,
        maxTurns: agent.limits.maxTurns,
        timeoutMs: agent.limits.timeoutMs,
        sessionId: this.sessions.get(agent.id),
        signal: this.abort.signal,
        onPermissionRequest: (request) =>
          this.gate.request({
            ...request,
            category: approvalCategoryFor(request.toolName, request.input, request.group as never),
          }),
      });

      for await (const event of stream) {
        switch (event.type) {
          case 'started':
            if (event.sessionId) this.sessions.set(agent.id, event.sessionId);
            break;

          case 'thinking':
            await this.setAgentStatus(agent, 'thinking');
            await this.recorder.record({
              runId: this.run.id,
              type: 'agent_thinking',
              agentId: agent.id,
              taskId: opts.taskId,
              level: 'debug',
              model: agent.model,
              effort: agent.effort,
              summary: `${agent.handle} is thinking`,
              data: { text: truncate(event.text, 2000) },
            });
            break;

          case 'text':
            text = event.text;
            await this.setAgentStatus(agent, 'working');
            await this.recorder.record({
              runId: this.run.id,
              type: 'agent_output',
              agentId: agent.id,
              taskId: opts.taskId,
              model: agent.model,
              effort: agent.effort,
              summary: `${agent.handle}: ${firstLine(event.text)}`,
              data: { text: event.text },
            });
            break;

          case 'tool_call':
            this.budget.recordToolCall();
            await this.setAgentStatus(agent, 'working');
            await this.recorder.record({
              runId: this.run.id,
              type: 'tool_call',
              agentId: agent.id,
              taskId: opts.taskId,
              level: 'debug',
              summary: `${agent.handle} → ${event.toolName}`,
              data: { toolName: event.toolName, input: event.input, toolCallId: event.toolCallId },
            });
            break;

          case 'tool_result':
            await this.recorder.record({
              runId: this.run.id,
              type: 'tool_result',
              agentId: agent.id,
              taskId: opts.taskId,
              level: event.isError ? 'warn' : 'debug',
              summary: `${agent.handle} ← ${event.toolName || 'tool'}${event.isError ? ' (error)' : ''}`,
              data: { summary: event.summary, isError: event.isError, toolCallId: event.toolCallId },
            });
            break;

          case 'permission_denied':
            await this.recorder.record({
              runId: this.run.id,
              type: 'error',
              agentId: agent.id,
              taskId: opts.taskId,
              level: 'warn',
              summary: `${agent.handle} was denied ${event.toolName}`,
              data: { reason: event.reason },
            });
            break;

          case 'completed':
            ok = true;
            text = event.result || text;
            usage = event.usage;
            costUsd = event.costUsd;
            if (event.sessionId) this.sessions.set(agent.id, event.sessionId);
            break;

          case 'error':
            ok = false;
            error = event.error.message;
            // A cancelled or failed activation still spent tokens; bill them.
            if (event.usage) usage = event.usage;
            if (event.costUsd !== undefined) costUsd = event.costUsd;
            if (event.error.code === 'cancelled') this.cancelled = true;
            break;
        }
      }
    } catch (err) {
      ok = false;
      error = toDomainError(err).message;
    } finally {
      this.budget.recordActivation(usage, costUsd);
      this.activationChains.delete(agent.id);
      releaseAgent();
      releaseSlot();

      const durationMs = Date.now() - startedAt;
      await this.recorder.record({
        runId: this.run.id,
        type: 'agent_stopped',
        agentId: agent.id,
        taskId: opts.taskId,
        model: agent.model,
        effort: agent.effort,
        usage,
        costUsd,
        durationMs,
        level: ok ? 'info' : 'error',
        summary: ok
          ? `${agent.handle} finished in ${formatDuration(durationMs)}`
          : `${agent.handle} failed: ${error}`,
        // The session the provider actually used. `agent_started` can only
        // carry the id from *before* the activation, which is undefined the
        // first time — so a run with one activation per agent had no session in
        // its timeline at all, and reopening it later started from nothing.
        data: { purpose: opts.purpose, ok, error, sessionId: this.sessions.get(agent.id) },
      });
      await this.setAgentStatus(agent, ok ? 'idle' : 'failed');
      await this.persistTotals();
    }

    return {
      ok,
      text: text.trim(),
      error,
      model: agent.model,
      effort: agent.effort,
      durationMs: Date.now() - startedAt,
      costUsd,
    };
  }

  /**
   * Raises (or lowers) the limits of a run that is executing right now.
   *
   * The tracker holds the budget the run started with, so persisting a new one
   * is not enough: without this, a run paused at its cost cap would keep
   * refusing work against a number nobody uses any more.
   */
  setBudget(budget: Budget | undefined): void {
    this.budget.replaceBudget(budget);
    this.run = { ...this.run, budget, updatedAt: new Date() };
  }

  /**
   * Answers a message the human sent to one agent.
   *
   * This is the path for writing to an agent after the run is over, which is
   * the common case: you read the result and want to ask about it. The agent is
   * activated once, resuming its own provider session, so it answers with the
   * run still in its head — and its answer becomes a real message back to you,
   * not just a line in the timeline.
   *
   * The run's own state is left alone. A finished run stays finished: it is not
   * secretly running again because somebody asked a question, and the state
   * machine has no transition out of a terminal state for good reasons.
   */
  async replyToHuman(agentId: string, message: AgentMessage): Promise<ActivationResult> {
    if (this.sessions.size === 0) await this.restoreSessions();
    const agent = this.agents.find((a) => a.id === agentId);
    if (!agent) throw notFound('Agent', agentId);

    await this.recorder.record({
      runId: this.run.id,
      type: 'message_received',
      agentId: agent.id,
      messageId: message.id,
      taskId: message.taskId,
      summary: `${agent.handle} received your message: ${firstLine(message.content)}`,
      data: { fromUser: true },
    });
    await this.deps.storage.messages.update({ ...message, status: 'processing' });

    const finished = isRunTerminal(this.run.status);
    const result = await this.activate({
      agent,
      prompt: buildHumanMessagePrompt({
        message: message.content,
        objective: this.run.objective,
        runStatus: this.run.status,
        finished,
      }),
      taskId: message.taskId,
      isOrchestrator: agent.id === this.ctx.orchestrator.id,
      purpose: 'answer',
      // A question about a finished run is not the run overrunning: the money
      // caps still hold, the wall clock and the activation circuit breaker do
      // not, or every follow-up after the run's own deadline would be refused
      // for ever.
      budgetScope: finished ? 'spend' : 'all',
    });

    await this.deps.storage.messages.update({
      ...message,
      status: result.ok ? 'completed' : 'failed',
      error: result.ok ? undefined : result.error,
      completedAt: new Date(),
    });

    if (result.ok && result.text.trim()) {
      // Sent through the bus so it is an ordinary message with a sequence
      // number, an event and a reply link — indistinguishable from any other
      // answer in the conversation, because that is what it is.
      await this.bus.send({
        from: agent,
        to: ['user'],
        type: 'answer',
        content: result.text.trim(),
        replyTo: message.id,
        taskId: message.taskId,
      });
    } else if (!result.ok) {
      await this.recorder.record({
        runId: this.run.id,
        type: 'error',
        agentId: agent.id,
        level: 'error',
        summary: `${agent.handle} could not answer you: ${result.error ?? 'unknown error'}`,
        data: { messageId: message.id },
      });
    }

    await this.persistTotals();
    await this.setAgentStatus(agent, finished ? 'completed' : 'idle');
    return result;
  }

  /** Activates an agent to answer a synchronous question from a teammate. */
  private async answerAsk(
    recipient: Agent,
    message: AgentMessage,
    chain: { hop: number; path: string[]; depth: number },
  ): Promise<string> {
    const asker = this.agents.find((a) => a.id === message.from);
    const result = await this.activate({
      agent: recipient,
      prompt: buildAnswerPrompt({
        question: message.content,
        fromHandle: asker?.handle ?? 'a teammate',
        objective: this.run.objective,
      }),
      taskId: message.taskId,
      isOrchestrator: recipient.id === this.ctx.orchestrator.id,
      purpose: 'answer',
      chain,
    });
    if (!result.ok) {
      throw new DomainError('agent_failed', result.error ?? `${recipient.handle} could not answer.`);
    }
    return result.text;
  }

  /**
   * Demotes `allow` to `ask` for any capability whose approval category the
   * user marked as always requiring a human. Capability grants can only get
   * stricter here, never looser.
   */
  private effectiveTools(agent: Agent): ToolPermission[] {
    if (this.options.autoApproveAll) return agent.tools;
    const required = new Set(this.options.requireApprovalFor);
    return agent.tools.map((p) =>
      p.mode === 'allow' && required.has(categoryForGroup(p.group)) ? { ...p, mode: 'ask' as const } : p,
    );
  }

  /* ---------------------------------------------------------------- *
   * ToolHost — the tools agents actually call
   * ---------------------------------------------------------------- */

  async sendMessage(
    sender: Agent,
    args: { to: string[]; type?: string; content: string },
  ): Promise<string> {
    const chain = this.activationChains.get(sender.id) ?? { hop: 0, path: [sender.id], depth: 0 };
    const result = await this.bus.send({
      from: sender,
      to: args.to,
      type: (args.type as never) ?? 'message',
      content: args.content,
      hop: chain.hop,
      path: chain.path,
      depth: chain.depth,
    });

    const lines: string[] = [];
    if (result.delivered.length > 0) {
      lines.push(`Delivered to: ${args.to.join(', ')}.`);
    }
    for (const r of result.rejected) {
      lines.push(`Not delivered to ${r.recipient}: ${r.reason}`);
    }
    return lines.join('\n') || 'Nothing was delivered.';
  }

  async askAgent(sender: Agent, args: { to: string; question: string }): Promise<string> {
    const chain = this.activationChains.get(sender.id) ?? { hop: 0, path: [sender.id], depth: 0 };
    try {
      const answer = await this.bus.ask(sender, args.to, args.question, chain);
      return `${args.to} answered:\n\n${answer}`;
    } catch (err) {
      const e = toDomainError(err);
      return `Could not get an answer from ${args.to}: ${e.message}`;
    }
  }

  async checkInbox(agent: Agent): Promise<string> {
    const pending = await this.bus.pending(agent.id);
    if (pending.length === 0) return 'Your inbox is empty.';
    await this.bus.markRead(pending);
    return pending
      .map(
        (m) =>
          `#${m.seq} from ${this.handleOf(m.from)} (${m.type}):\n${m.content}`,
      )
      .join('\n\n---\n\n');
  }

  async askUser(
    agent: Agent,
    args: {
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      allowMultiple?: boolean;
      allowFreeform?: boolean;
    },
  ): Promise<string> {
    const task = this.tasks.find(
      (t) => t.assignedAgentId === agent.id && (t.status === 'running' || t.status === 'review'),
    );
    await this.setAgentStatus(agent, 'waiting');
    try {
      return await this.questions.ask({
        agentId: agent.id,
        agentHandle: agent.handle,
        question: args.question,
        header: args.header,
        options: args.options,
        allowMultiple: args.allowMultiple,
        allowFreeform: args.allowFreeform,
        taskId: task?.id,
      });
    } finally {
      await this.setAgentStatus(agent, 'working');
    }
  }

  async remember(agent: Agent, note: string): Promise<string> {
    const stored = await this.deps.storage.agents.get(agent.id);
    if (!stored) return 'Your memory could not be saved: the agent record is missing.';
    const stamp = new Date().toISOString().slice(0, 10);
    const notes = `${stored.memory.notes.trim()}\n- (${stamp}) ${note.trim()}`.trim();
    const updated: Agent = {
      ...stored,
      memory: { ...stored.memory, notes },
      updatedAt: new Date(),
    };
    await this.deps.storage.agents.update(updated);
    const local = this.agents.find((a) => a.id === agent.id);
    if (local) local.memory = updated.memory;
    return 'Noted.';
  }

  async createTasks(sender: Agent, specs: TaskSpecInput[]): Promise<string> {
    const created: Task[] = [];
    const keyToId = new Map<string, string>();
    const problems: string[] = [];

    // First pass: create every task without dependencies so keys can resolve.
    for (const spec of specs) {
      const assignee = this.resolveAgent(spec.assignee);
      if (!assignee) {
        problems.push(`No agent called "${spec.assignee}" — task "${spec.title}" was not created.`);
        continue;
      }
      const reviewer = spec.reviewer ? this.resolveAgent(spec.reviewer) : undefined;
      if (spec.reviewer && !reviewer) {
        problems.push(`No reviewer called "${spec.reviewer}" — "${spec.title}" was created unreviewed.`);
      }
      const task = createTask({
        runId: this.run.id,
        title: spec.title,
        description: spec.description,
        assignedAgentId: assignee.id,
        createdBy: sender.id,
        reviewerAgentId: reviewer?.id,
        order: this.tasks.length + created.length,
      });
      created.push(task);
      keyToId.set(spec.key, task.id);
    }

    // Second pass: resolve dependencies now that every key has an id.
    for (const spec of specs) {
      const id = keyToId.get(spec.key);
      if (!id) continue;
      const task = created.find((t) => t.id === id)!;
      const deps: string[] = [];
      for (const ref of spec.dependsOn ?? []) {
        const resolved = keyToId.get(ref) ?? this.tasks.find((t) => t.id === ref)?.id;
        if (resolved) deps.push(resolved);
        else problems.push(`Task "${spec.title}" depends on unknown "${ref}" — dependency dropped.`);
      }
      task.dependencies = deps;
      task.status = deps.length > 0 ? 'pending' : 'ready';
    }

    const all = [...this.tasks, ...created];
    for (const task of created) {
      try {
        assertNoCycle(all, task.id, task.dependencies);
      } catch {
        task.dependencies = [];
        task.status = 'ready';
        problems.push(`Dependencies of "${task.title}" formed a cycle and were cleared.`);
      }
    }

    if (created.length === 0) {
      return `No tasks were created.\n${problems.join('\n')}`;
    }

    await this.deps.storage.tasks.createMany(created);
    this.tasks.push(...created);

    for (const task of created) {
      await this.recorder.record({
        runId: this.run.id,
        type: 'task_created',
        taskId: task.id,
        agentId: sender.id,
        summary: `${sender.handle} created "${task.title}"`,
        data: { title: task.title, dependencies: task.dependencies },
      });
      if (task.assignedAgentId) {
        await this.recorder.record({
          runId: this.run.id,
          type: 'task_assigned',
          taskId: task.id,
          agentId: task.assignedAgentId,
          summary: `"${task.title}" assigned to ${this.handleOf(task.assignedAgentId)}`,
          data: {},
        });
      }
    }

    await this.syncTaskStatuses();

    return [
      `Created ${created.length} task(s):`,
      ...created.map(
        (t) => `- ${t.id} "${t.title}" → ${this.handleOf(t.assignedAgentId ?? '')} [${t.status}]`,
      ),
      ...problems,
      '',
      'They will be dispatched as soon as this activation ends.',
    ].join('\n');
  }

  async listTasks(): Promise<string> {
    this.tasks = await this.deps.storage.tasks.listByRun(this.run.id);
    return renderTaskBoard(this.tasks, this.agents);
  }

  async updateTask(
    sender: Agent,
    args: { taskId: string; status?: string; assignee?: string; note?: string },
  ): Promise<string> {
    const task = this.tasks.find((t) => t.id === args.taskId);
    if (!task) return `No task with id "${args.taskId}".`;

    const patch: Partial<Task> = {};
    if (args.assignee) {
      const agent = this.resolveAgent(args.assignee);
      if (!agent) return `No agent called "${args.assignee}".`;
      patch.assignedAgentId = agent.id;
    }
    if (args.status) {
      patch.status = args.status as TaskStatus;
      if (args.status === 'ready') patch.attempts = 0;
    }
    if (args.note) {
      patch.description = `${task.description}\n\n[${sender.handle}] ${args.note}`.trim();
    }

    await this.updateTaskState(task, patch);
    await this.recorder.record({
      runId: this.run.id,
      type: patch.assignedAgentId ? 'task_assigned' : 'task_created',
      taskId: task.id,
      agentId: sender.id,
      summary: `${sender.handle} updated "${task.title}"`,
      data: { ...args },
    });
    await this.syncTaskStatuses();
    return `Task "${task.title}" updated: ${JSON.stringify({ ...args, taskId: undefined })}`;
  }

  async finish(sender: Agent, summary: string): Promise<string> {
    const outstanding = this.tasks.filter((t) => !isTaskTerminal(t.status));

    // Guard against the common mistake of planning and finishing in the same
    // breath: tasks are dispatched *after* the activation ends, so calling
    // `finish` now would throw the plan away before anyone ran it. Refuse once,
    // explain why, and honour a second, deliberate call.
    const neverRan = outstanding.filter((t) => t.attempts === 0);
    if (neverRan.length > 0 && !this.finishRefused) {
      this.finishRefused = true;
      return [
        `Not finishing yet: ${neverRan.length} task(s) have not run at all.`,
        'Tasks you created are dispatched automatically as soon as this activation ends,',
        'and you will be shown their results in the next round.',
        '',
        neverRan.map((t) => `- ${t.id} "${t.title}" [${t.status}]`).join('\n'),
        '',
        'End this activation now and let them run. If you genuinely want to abandon the run,',
        'call `finish` again and it will be honoured.',
      ].join('\n');
    }

    this.finishSummary = summary;
    await this.recorder.record({
      runId: this.run.id,
      type: 'log',
      agentId: sender.id,
      summary: `${sender.handle} finished the run`,
      data: { summary: truncate(summary, 1000), outstandingTasks: outstanding.length },
    });
    return outstanding.length === 0
      ? 'Run closed. Your summary has been delivered to the human.'
      : `Run closed with ${outstanding.length} unfinished task(s). Your summary has been delivered.`;
  }

  /* ---------------------------------------------------------------- *
   * State helpers
   * ---------------------------------------------------------------- */

  private resolveAgent(ref: string): Agent | undefined {
    const needle = ref.trim();
    return (
      this.agents.find((a) => a.handle === needle) ??
      this.agents.find((a) => a.id === needle) ??
      this.agents.find((a) => a.name.toLowerCase() === needle.toLowerCase())
    );
  }

  private handleOf(id: string): string {
    if (id === 'user') return 'user';
    return this.agents.find((a) => a.id === id)?.handle ?? id;
  }

  private async updateTaskState(task: Task, patch: Partial<Task>): Promise<void> {
    Object.assign(task, patch, { updatedAt: new Date() });
    await this.deps.storage.tasks.update(task);
  }

  private async syncTaskStatuses(): Promise<void> {
    const changed = recomputeTaskStatuses(this.tasks);
    if (changed.length > 0) {
      await this.deps.storage.tasks.updateMany(changed);
      for (const task of changed.filter((t) => t.status === 'blocked')) {
        await this.recorder.record({
          runId: this.run.id,
          type: 'task_blocked',
          taskId: task.id,
          level: 'warn',
          summary: `"${task.title}" is blocked by a failed dependency`,
          data: {},
        });
      }
    }
  }

  private async setAgentStatus(agent: Agent, status: AgentStatus): Promise<void> {
    if (agent.status === status) return;
    agent.status = status;
    const stored = await this.deps.storage.agents.get(agent.id);
    if (stored) await this.deps.storage.agents.update({ ...stored, status, updatedAt: new Date() });
    this.deps.onAgentStatus?.(agent.id, status);
    await this.recorder.record({
      runId: this.run.id,
      type: 'agent_status_changed',
      agentId: agent.id,
      level: 'debug',
      summary: `${agent.handle} is ${status}`,
      data: { status },
    });
  }

  private async resetAgentStatuses(): Promise<void> {
    for (const agent of this.agents) {
      if (agent.status !== 'idle') await this.setAgentStatus(agent, 'idle');
    }
  }

  private async setRunStatus(status: RunStatus): Promise<void> {
    if (this.run.status === status) return;
    this.run = { ...this.run, status, updatedAt: new Date() };
    await this.persistRun();
    this.deps.onRunStatus?.(this.run.id, status);
  }

  private async persistRun(): Promise<void> {
    this.run = { ...this.run, totals: this.budget.totals, updatedAt: new Date() };
    await this.deps.storage.runs.update(this.run);
  }

  private async persistTotals(): Promise<void> {
    await this.persistRun();
  }

  private progressFingerprint(): string {
    return this.tasks
      .map((t) => `${t.id}:${t.status}:${t.attempts}:${t.assignedAgentId ?? ''}`)
      .sort()
      .join('|');
  }

  private async messagesForOrchestrator(): Promise<AgentMessage[]> {
    const inbox = await this.bus.pending(this.ctx.orchestrator.id);
    const fresh = inbox.filter((m) => m.seq > this.lastOrchestratorMessageSeq);
    if (fresh.length > 0) {
      this.lastOrchestratorMessageSeq = Math.max(...fresh.map((m) => m.seq));
      await this.bus.markRead(fresh);
    }
    return fresh;
  }

  /**
   * Rebuilds provider session ids from the timeline, so an agent picked up
   * later — after a restart, or to answer a message once the run is over —
   * continues its own conversation instead of starting a new one.
   *
   * Both event types are read, in sequence order, because `agent_started`
   * records the session it resumed and `agent_stopped` records the one the
   * activation ended with. The last value wins.
   */
  private async restoreSessions(): Promise<void> {
    const events = await this.deps.storage.events.list({
      runId: this.run.id,
      types: ['agent_started', 'agent_stopped'],
    });
    for (const event of events) {
      const sessionId = event.data?.sessionId;
      if (event.agentId && typeof sessionId === 'string') this.sessions.set(event.agentId, sessionId);
    }
  }

  private async waitWhilePaused(): Promise<void> {
    if (!this.pauseRequested || this.cancelled) return;

    await this.setRunStatus('paused');
    await this.recorder.record({
      runId: this.run.id,
      type: 'run_paused',
      summary: 'Run paused by the human.',
      data: {},
    });

    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pauseGate = { promise, release };
    await promise;

    if (this.cancelled) return;
    await this.setRunStatus('running');
    await this.recorder.record({
      runId: this.run.id,
      type: 'run_resumed',
      summary: 'Run resumed.',
      data: {},
    });
  }

  private lockFor(agentId: string): Mutex {
    let lock = this.agentLocks.get(agentId);
    if (!lock) {
      lock = new Mutex();
      this.agentLocks.set(agentId, lock);
    }
    return lock;
  }

  private async acquireSlot(): Promise<() => void> {
    if (this.activeSlots < this.options.maxConcurrentAgents) {
      this.activeSlots += 1;
      return () => this.releaseSlot();
    }
    await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    this.activeSlots += 1;
    return () => this.releaseSlot();
  }

  private releaseSlot(): void {
    this.activeSlots = Math.max(0, this.activeSlots - 1);
    const next = this.slotWaiters.shift();
    if (next) next();
  }

  /* ---------------------------------------------------------------- *
   * Termination
   * ---------------------------------------------------------------- */

  private async forceFinish(reason: string): Promise<void> {
    if (this.finishSummary !== undefined) return;
    const completed = this.tasks.filter((t) => t.status === 'completed');
    this.finishSummary = [
      reason,
      '',
      completed.length > 0
        ? `Completed tasks:\n${completed.map((t) => `- ${t.title}`).join('\n')}`
        : 'No task was completed.',
    ].join('\n');
  }

  private async finalise(): Promise<void> {
    if (this.settled) return;

    if (this.cancelled) {
      await this.terminate('cancelled', 'The run was cancelled.');
      return;
    }

    const failed = this.tasks.filter((t) => t.status === 'failed');
    // A run only *fails* when it produced nothing usable: every task failed and
    // the orchestrator never delivered a summary. Partial failure with a
    // summary is a completed run that honestly reports what did not work.
    const everythingFailed =
      this.tasks.length > 0 && this.tasks.every((t) => t.status === 'failed' || t.status === 'cancelled');
    const status: RunStatus =
      everythingFailed && this.finishSummary === undefined ? 'failed' : 'completed';

    if (status === 'failed') {
      await this.terminate('failed', 'Every task failed and no result was produced.');
      return;
    }

    await this.cancelOutstandingTasks();
    this.run = {
      ...this.run,
      summary: this.finishSummary ?? 'The run ended without a summary.',
      completedAt: new Date(),
    };
    await this.setRunStatus(status);
    await this.persistRun();
    this.settled = true;

    await this.recorder.record({
      runId: this.run.id,
      type: 'run_completed',
      summary: `Run completed${failed.length ? ` with ${failed.length} failed task(s)` : ''}`,
      data: { summary: this.run.summary, totals: this.budget.totals },
      usage: this.budget.totals.usage,
      costUsd: this.budget.totals.costUsd,
    });
  }

  private async terminate(status: 'failed' | 'cancelled', message: string): Promise<void> {
    if (this.settled) return;
    await this.cancelOutstandingTasks();
    this.run = {
      ...this.run,
      error: message,
      summary: this.finishSummary ?? this.run.summary,
      completedAt: new Date(),
    };
    await this.setRunStatus(status);
    await this.persistRun();
    this.settled = true;

    await this.recorder.record({
      runId: this.run.id,
      type: status === 'cancelled' ? 'run_cancelled' : 'run_failed',
      level: status === 'cancelled' ? 'warn' : 'error',
      summary: message,
      data: { totals: this.budget.totals },
    });
  }

  private async cancelOutstandingTasks(): Promise<void> {
    const outstanding = this.tasks.filter(
      (t) => t.status === 'running' || t.status === 'review' || t.status === 'ready' || t.status === 'pending',
    );
    if (outstanding.length === 0) return;
    const now = new Date();
    for (const task of outstanding) {
      task.status = 'cancelled';
      task.updatedAt = now;
      task.completedAt = now;
    }
    await this.deps.storage.tasks.updateMany(outstanding);
  }
}

function firstLine(text: string, max = 120): string {
  const line = (text ?? '').trim().split('\n')[0] ?? '';
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function truncate(text: string, max: number): string {
  const t = (text ?? '').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
