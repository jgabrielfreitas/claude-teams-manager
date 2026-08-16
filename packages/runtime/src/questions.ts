import { createQuestion, type AgentQuestion, type QuestionOption } from '@claude-team/domain';
import type { Storage } from '@claude-team/persistence';
import type { EventRecorder } from './recorder.js';

/**
 * Questions from an agent to the human.
 *
 * Deliberately a separate mechanism from `ApprovalGate`. An approval answers
 * "may I do this?" and returns yes or no; a question returns *content* the
 * agent then works from. Routing one through the other — which is what happens
 * when a provider's built-in ask-the-user tool is mistaken for an unknown
 * capability — grants permission without ever delivering an answer, and the
 * agent stalls waiting for something that will never arrive.
 *
 * When nobody is available (auto mode, or the timeout elapses) the agent is not
 * left hanging: it is told to decide for itself and to state the assumption, so
 * the run continues and the human can see what was assumed.
 */

export interface QuestionGateOptions {
  /** Answer automatically instead of waiting for a human. */
  autoAnswer: boolean;
  timeoutMs: number;
  onQuestion?: (question: AgentQuestion) => void;
}

export interface AskUserInput {
  agentId: string;
  agentHandle: string;
  question: string;
  header?: string;
  options?: QuestionOption[];
  allowMultiple?: boolean;
  allowFreeform?: boolean;
  taskId?: string;
}

/** What the agent is told when there is no human to answer. */
export function unattendedAnswer(question: string): string {
  return [
    'No human is available to answer (the run is in auto mode).',
    '',
    `Question: ${question}`,
    '',
    'Decide this yourself using your best judgement. Pick the option that is easiest to',
    'reverse if it turns out wrong, state clearly in your output which assumption you made',
    'and why, and carry on. Do not ask again.',
  ].join('\n');
}

function timedOutAnswer(question: string, minutes: number): string {
  return [
    `Nobody answered within ${minutes} minute(s), so the run is continuing without an answer.`,
    '',
    `Question: ${question}`,
    '',
    'Decide it yourself, prefer the most reversible option, and state the assumption you made.',
  ].join('\n');
}

export class QuestionGate {
  private readonly pending = new Map<
    string,
    { question: AgentQuestion; resolve: (answer: string) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly runId: string,
    private readonly storage: Storage,
    private readonly recorder: EventRecorder,
    private readonly options: QuestionGateOptions,
  ) {}

  listPending(): AgentQuestion[] {
    return [...this.pending.values()].map((p) => p.question);
  }

  async ask(input: AskUserInput): Promise<string> {
    const question = createQuestion({
      runId: this.runId,
      agentId: input.agentId,
      question: input.question,
      header: input.header,
      options: input.options,
      allowMultiple: input.allowMultiple,
      allowFreeform: input.allowFreeform,
      taskId: input.taskId,
      expiresAt: new Date(Date.now() + this.options.timeoutMs),
    });

    if (this.options.autoAnswer) {
      const answer = unattendedAnswer(question.question);
      await this.storage.questions.create({
        ...question,
        status: 'skipped',
        answer,
        answeredBy: 'auto',
        answeredAt: new Date(),
      });
      await this.recorder.record({
        runId: this.runId,
        type: 'log',
        agentId: input.agentId,
        taskId: input.taskId,
        level: 'warn',
        summary: `${input.agentHandle} asked a question; auto mode answered it: ${firstLine(question.question)}`,
        data: { questionId: question.id, auto: true },
      });
      return answer;
    }

    await this.storage.questions.create(question);
    await this.recorder.record({
      runId: this.runId,
      type: 'approval_requested',
      agentId: input.agentId,
      taskId: input.taskId,
      level: 'warn',
      summary: `${input.agentHandle} is asking you: ${firstLine(question.question)}`,
      data: {
        questionId: question.id,
        kind: 'question',
        options: question.options.map((o) => o.label),
      },
    });
    this.options.onQuestion?.(question);

    return await new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        void this.settle(
          question.id,
          timedOutAnswer(question.question, Math.round(this.options.timeoutMs / 60_000)),
          'timeout',
          'expired',
        );
      }, this.options.timeoutMs);
      timer.unref?.();
      this.pending.set(question.id, { question, resolve, timer });
    });
  }

  /** Called by the application core when a human answers. */
  answer(questionId: string, answer: string, answeredBy = 'user'): boolean {
    if (!this.pending.has(questionId)) return false;
    void this.settle(questionId, answer, answeredBy, 'answered');
    return true;
  }

  /** Releases everything still waiting; used when a run ends or is cancelled. */
  async abandonAll(reason: string): Promise<void> {
    for (const id of [...this.pending.keys()]) {
      await this.settle(id, reason, 'system', 'skipped');
    }
  }

  private async settle(
    questionId: string,
    answer: string,
    answeredBy: string,
    status: AgentQuestion['status'],
  ): Promise<void> {
    const entry = this.pending.get(questionId);
    if (!entry) return;
    this.pending.delete(questionId);
    clearTimeout(entry.timer);

    const updated: AgentQuestion = {
      ...entry.question,
      status,
      answer,
      answeredBy,
      answeredAt: new Date(),
    };
    await this.storage.questions.update(updated);

    await this.recorder.record({
      runId: this.runId,
      type: 'approval_resolved',
      agentId: entry.question.agentId,
      taskId: entry.question.taskId,
      level: status === 'answered' ? 'info' : 'warn',
      summary:
        status === 'answered'
          ? `You answered: ${firstLine(answer)}`
          : `Question closed without an answer (${answeredBy})`,
      data: { questionId, kind: 'question', status, answeredBy },
    });
    this.options.onQuestion?.(updated);

    entry.resolve(answer);
  }
}

function firstLine(text: string, max = 120): string {
  const line = (text ?? '').trim().split('\n')[0] ?? '';
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
