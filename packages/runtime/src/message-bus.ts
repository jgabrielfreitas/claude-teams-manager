import {
  DomainError,
  USER_PARTICIPANT,
  checkRoute,
  createMessage,
  ids,
  rejectionToError,
  type Agent,
  type AgentMessage,
  type AgentMessageType,
  type RoutingLimits,
} from '@claude-team/domain';
import type { Storage } from '@claude-team/persistence';
import type { EventRecorder } from './recorder.js';

/**
 * The agent-to-agent message bus (ADR-003).
 *
 * Two delivery modes:
 *  - `send` is asynchronous. The message lands in the recipient's inbox and is
 *    injected into its next activation. Nobody blocks.
 *  - `ask` is synchronous. The sender is parked while the recipient is
 *    activated to answer, and the answer comes back as a return value.
 *
 * Every delivery passes the routing guards first: permission (`canMessage`),
 * hop limit, recursion depth, per-agent message limit, and a cycle check that
 * refuses an ask that would return to an agent already waiting upstream —
 * which is exactly the shape a two-agent deadlock takes.
 */

export interface SendOptions {
  /** Agent sending the message, or `undefined` when it comes from the human. */
  from?: Agent;
  /** Handles or ids; the literal `user` is always a valid recipient. */
  to: string[];
  type?: AgentMessageType;
  content: string;
  taskId?: string;
  replyTo?: string;
  correlationId?: string;
  hop?: number;
  path?: string[];
  depth?: number;
}

export interface SendResult {
  delivered: AgentMessage[];
  rejected: Array<{ recipient: string; reason: string }>;
}

/** Activates an agent so it can answer a synchronous question. */
export type AskHandler = (
  recipient: Agent,
  message: AgentMessage,
  chain: { hop: number; path: string[]; depth: number },
) => Promise<string>;

export class MessageBus {
  private readonly received = new Map<string, number>();
  /** One mutex per agent, so synchronous asks to the same agent queue up. */
  private readonly answering = new Map<string, Mutex>();

  constructor(
    private readonly runId: string,
    private readonly storage: Storage,
    private readonly recorder: EventRecorder,
    private readonly agents: Agent[],
    private readonly limits: RoutingLimits,
    private readonly askHandler: AskHandler,
    private readonly askTimeoutMs: number,
    private readonly onMessage: (message: AgentMessage) => void = () => {},
  ) {}

  /** Refreshes the roster after an agent is edited mid-run. */
  setAgents(agents: Agent[]): void {
    this.agents.splice(0, this.agents.length, ...agents);
  }

  resolveParticipant(ref: string): Agent | 'user' | undefined {
    const needle = ref.trim();
    if (needle === USER_PARTICIPANT) return 'user';
    return (
      this.agents.find((a) => a.handle === needle) ??
      this.agents.find((a) => a.id === needle) ??
      this.agents.find((a) => a.name.toLowerCase() === needle.toLowerCase())
    );
  }

  /* ---------------------------------------------------------------- *
   * Asynchronous send
   * ---------------------------------------------------------------- */

  async send(options: SendOptions): Promise<SendResult> {
    const rejected: Array<{ recipient: string; reason: string }> = [];
    const recipients: Array<Agent | 'user'> = [];

    for (const ref of options.to) {
      const resolved = this.resolveParticipant(ref);
      if (!resolved) {
        rejected.push({ recipient: ref, reason: `No agent called "${ref}" on this team.` });
        continue;
      }
      recipients.push(resolved);
    }

    const agentRecipients = recipients.filter((r): r is Agent => r !== 'user');
    const wantsUser = recipients.includes('user');

    let allowed: Agent[] = agentRecipients;

    if (options.from) {
      const messagesInRun = await this.storage.messages.countByRun(this.runId);
      const check = checkRoute({
        sender: options.from,
        recipients: agentRecipients,
        hop: options.hop ?? 0,
        path: options.path ?? [options.from.id],
        messagesInRun,
        limits: this.limits,
        depth: options.depth ?? 0,
      });
      allowed = check.allowed;
      for (const r of check.rejections) {
        rejected.push({ recipient: 'recipient' in r ? r.recipient : '*', reason: r.reason });
      }
      // A global guard (hop/message/recursion limit) blocks every recipient,
      // including the human.
      if (check.allowed.length === 0 && check.rejections.some((r) => !('recipient' in r))) {
        await this.recordRejections(options.from, rejected);
        return { delivered: [], rejected };
      }
    }

    // Per-agent inbox limit.
    const withinLimit: Agent[] = [];
    for (const agent of allowed) {
      const max = agent.limits.maxMessages;
      const count = this.received.get(agent.id) ?? 0;
      if (max !== undefined && count >= max) {
        rejected.push({
          recipient: agent.handle,
          reason: `${agent.handle} reached its inbox limit of ${max} messages for this run.`,
        });
        continue;
      }
      withinLimit.push(agent);
    }

    // Every refusal is visible to the human, not only to the sending agent.
    await this.recordRejections(options.from, rejected);

    const targets = [...withinLimit.map((a) => a.id), ...(wantsUser ? [USER_PARTICIPANT] : [])];
    if (targets.length === 0) return { delivered: [], rejected };

    const seq = await this.storage.messages.nextSeq(this.runId);
    const message = createMessage({
      runId: this.runId,
      seq,
      from: options.from?.id ?? USER_PARTICIPANT,
      to: targets,
      type: options.type ?? 'message',
      content: options.content,
      taskId: options.taskId,
      replyTo: options.replyTo,
      correlationId: options.correlationId,
      hop: (options.hop ?? 0) + (options.from ? 1 : 0),
      path: [...(options.path ?? []), options.from?.id ?? USER_PARTICIPANT],
    });

    await this.storage.messages.create(message);
    for (const agent of withinLimit) {
      this.received.set(agent.id, (this.received.get(agent.id) ?? 0) + 1);
    }

    const fromLabel = options.from?.handle ?? 'user';
    const toLabel = targets
      .map((t) => (t === USER_PARTICIPANT ? 'user' : this.agents.find((a) => a.id === t)?.handle ?? t))
      .join(', ');

    await this.recorder.record({
      runId: this.runId,
      type: 'message_sent',
      agentId: options.from?.id,
      messageId: message.id,
      taskId: options.taskId,
      summary: `${fromLabel} → ${toLabel}: ${firstLine(options.content)}`,
      data: { type: message.type, to: toLabel, seq: message.seq },
    });
    this.onMessage(message);

    return { delivered: [message], rejected };
  }

  /* ---------------------------------------------------------------- *
   * Synchronous ask
   * ---------------------------------------------------------------- */

  async ask(
    from: Agent,
    toRef: string,
    question: string,
    chain: { hop: number; path: string[]; depth: number },
    taskId?: string,
  ): Promise<string> {
    const recipient = this.resolveParticipant(toRef);
    if (recipient === undefined) {
      throw new DomainError('not_found', `No agent called "${toRef}" on this team.`);
    }
    if (recipient === 'user') {
      throw new DomainError(
        'validation',
        'You cannot block on the human. Use send_message to notify them instead.',
      );
    }

    const messagesInRun = await this.storage.messages.countByRun(this.runId);
    const check = checkRoute({
      sender: from,
      recipients: [recipient],
      hop: chain.hop,
      path: chain.path,
      messagesInRun,
      limits: this.limits,
      depth: chain.depth,
    });
    if (check.allowed.length === 0) {
      const rejection = check.rejections[0];
      await this.recordRejection(from, rejection.reason);
      throw rejectionToError(rejection);
    }

    const correlationId = ids.uuid();
    const seq = await this.storage.messages.nextSeq(this.runId);
    const question$ = createMessage({
      runId: this.runId,
      seq,
      from: from.id,
      to: [recipient.id],
      type: 'question',
      content: question,
      taskId,
      correlationId,
      hop: chain.hop + 1,
      path: [...chain.path, from.id],
    });
    await this.storage.messages.create(question$);
    await this.recorder.record({
      runId: this.runId,
      type: 'message_sent',
      agentId: from.id,
      messageId: question$.id,
      taskId,
      summary: `${from.handle} asked ${recipient.handle}: ${firstLine(question)}`,
      data: { type: 'question', synchronous: true, seq: question$.seq },
    });
    this.onMessage(question$);

    // Serialise per recipient so two askers cannot activate the same agent
    // concurrently and interleave its context.
    const release = await withTimeout(
      this.lockFor(recipient.id).acquire(),
      this.askTimeoutMs,
      `${recipient.handle} stayed busy for too long.`,
    );

    try {
      await this.markProcessing(question$);
      const answerText = await withTimeout(
        this.askHandler(recipient, question$, {
          hop: question$.hop,
          path: question$.path,
          depth: chain.depth + 1,
        }),
        this.askTimeoutMs,
        `${recipient.handle} did not answer within the timeout.`,
      );

      const answerSeq = await this.storage.messages.nextSeq(this.runId);
      const answer = createMessage({
        runId: this.runId,
        seq: answerSeq,
        from: recipient.id,
        to: [from.id],
        type: 'answer',
        content: answerText || '(no answer)',
        taskId,
        replyTo: question$.id,
        correlationId,
        hop: question$.hop + 1,
        path: [...question$.path, recipient.id],
      });
      await this.storage.messages.create(answer);
      await this.storage.messages.update({
        ...question$,
        status: 'completed',
        completedAt: new Date(),
      });
      await this.recorder.record({
        runId: this.runId,
        type: 'message_sent',
        agentId: recipient.id,
        messageId: answer.id,
        taskId,
        summary: `${recipient.handle} answered ${from.handle}: ${firstLine(answerText)}`,
        data: { type: 'answer', synchronous: true, seq: answer.seq },
      });
      this.onMessage(answer);

      return answerText;
    } catch (err) {
      await this.storage.messages.update({
        ...question$,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      release();
    }
  }

  private lockFor(agentId: string): Mutex {
    let lock = this.answering.get(agentId);
    if (!lock) {
      lock = new Mutex();
      this.answering.set(agentId, lock);
    }
    return lock;
  }

  /* ---------------------------------------------------------------- *
   * Inbox
   * ---------------------------------------------------------------- */

  async inbox(agentId: string): Promise<AgentMessage[]> {
    return this.storage.messages.list({ runId: this.runId, toParticipant: agentId });
  }

  async pending(agentId: string): Promise<AgentMessage[]> {
    const all = await this.inbox(agentId);
    return all.filter((m) => m.status === 'pending');
  }

  async markRead(messages: AgentMessage[]): Promise<void> {
    const now = new Date();
    for (const m of messages) {
      if (m.status !== 'pending') continue;
      const updated: AgentMessage = { ...m, status: 'read', readAt: now };
      await this.storage.messages.update(updated);
      this.onMessage(updated);
    }
  }

  async markCompleted(message: AgentMessage): Promise<void> {
    const updated: AgentMessage = { ...message, status: 'completed', completedAt: new Date() };
    await this.storage.messages.update(updated);
    this.onMessage(updated);
  }

  private async markProcessing(message: AgentMessage): Promise<void> {
    const updated: AgentMessage = { ...message, status: 'processing', readAt: new Date() };
    await this.storage.messages.update(updated);
    this.onMessage(updated);
  }

  private async recordRejection(from: Agent, reason: string): Promise<void> {
    await this.recorder.record({
      runId: this.runId,
      type: 'error',
      agentId: from.id,
      summary: `Message from ${from.handle} was not delivered: ${reason}`,
      level: 'warn',
      data: { reason },
    });
  }

  private async recordRejections(
    from: Agent | undefined,
    rejections: Array<{ recipient: string; reason: string }>,
  ): Promise<void> {
    if (rejections.length === 0) return;
    const sender = from?.handle ?? 'user';
    for (const rejection of rejections) {
      await this.recorder.record({
        runId: this.runId,
        type: 'error',
        agentId: from?.id,
        level: 'warn',
        summary: `Message from ${sender} to ${rejection.recipient} was not delivered: ${rejection.reason}`,
        data: { recipient: rejection.recipient, reason: rejection.reason },
      });
    }
  }
}

/** Minimal FIFO mutex. `acquire()` resolves with the release function. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => held);
    await previous;
    return release;
  }
}

function firstLine(text: string, max = 120): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new DomainError('timeout', message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
