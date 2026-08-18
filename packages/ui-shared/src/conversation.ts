import type { AgentEffort, AgentMessageType, RunEventType } from '@claude-team/domain';
import type { Tone } from './presentation.js';

/**
 * A run, read as a conversation.
 *
 * The timeline answers "what happened, in order, with what it cost"; it is a
 * log, and every entry is one line by design. But the thing people actually
 * want to read is what the agents *said* — the full text, in order, with the
 * questions they asked you and the messages they sent each other in their
 * proper places. That text was already stored (`agent_output` events carry the
 * complete body); nothing rendered it.
 *
 * Composing it is a product decision — what counts as a turn, what is folded
 * into it, what is demoted to a note — so it lives here rather than in a React
 * component or an Ink view, and both surfaces read the same conversation.
 *
 * Inputs are structural so the same function takes domain entities (with
 * `Date`) in the TUI and DTOs (with ISO strings) in the browser.
 */

export type ConversationTurnKind =
  /** What you asked the team to do. */
  | 'objective'
  /** An agent's own output. */
  | 'say'
  /** One agent writing to another. */
  | 'message'
  /** An agent asking you something it cannot decide alone. */
  | 'ask'
  /** Your answer, or auto mode's. */
  | 'answer'
  /** A permission asked for, granted or refused. */
  | 'approval'
  /** Something the run did that is not speech: a task moved, a budget warning. */
  | 'note'
  /** The run's final summary. */
  | 'result';

export interface ConversationToolCall {
  id: string;
  /** The provider's id for the call, used to pair a result with it. */
  callId?: string;
  name: string;
  /** One line describing the call, ready to show without expanding. */
  detail: string;
  /** The arguments, for anyone who opens it. */
  input?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface ConversationTurn {
  id: string;
  kind: ConversationTurnKind;
  /** Who is speaking: an agent handle, `you`, or undefined for system notes. */
  speaker?: string;
  speakerId?: string;
  /** Recipients, for agent-to-agent messages. */
  to?: string[];
  /** The full body. Never truncated — that is the whole point of this view. */
  text: string;
  tone: Tone;
  at: string;
  taskId?: string;
  model?: string;
  effort?: AgentEffort;
  costUsd?: number;
  durationMs?: number;
  /** Tool calls the agent made on the way to this turn. */
  tools: ConversationToolCall[];
  /** Reasoning, when it was recorded and the reader asked to see it. */
  thinking?: string;
  /** Options offered with a question. */
  options?: Array<{ label: string; description?: string }>;
  /** Message type and delivery state, for `message` turns. */
  messageType?: AgentMessageType;
  messageStatus?: string;
  /** Sequence of the underlying record, for linking back to the timeline. */
  seq?: number;
  /** Set on turns whose event carried an error level. */
  failed?: boolean;
}

export interface ConversationEventInput {
  id: string;
  seq: number;
  type: RunEventType;
  agentId?: string;
  taskId?: string;
  summary: string;
  data?: Record<string, unknown>;
  model?: string;
  effort?: AgentEffort;
  costUsd?: number;
  durationMs?: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  createdAt: Date | string;
}

export interface ConversationMessageInput {
  id: string;
  seq: number;
  from: string;
  to: string[];
  type: AgentMessageType;
  content: string;
  status: string;
  taskId?: string;
  createdAt: Date | string;
}

export interface ConversationQuestionInput {
  id: string;
  agentId: string;
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  status: string;
  answer?: string;
  answeredBy?: string;
  createdAt: Date | string;
  answeredAt?: Date | string;
}

export interface ConversationAgentInput {
  id: string;
  handle: string;
  name?: string;
}

export interface ConversationRunInput {
  objective: string;
  summary?: string;
  error?: string;
  createdAt: Date | string;
  completedAt?: Date | string;
}

export interface ConversationOptions {
  /** Include the reasoning recorded before an agent spoke. */
  includeThinking?: boolean;
  /** Include tool calls, folded into the turn that follows them. */
  includeTools?: boolean;
  /** Include task and run bookkeeping as thin notes. */
  includeNotes?: boolean;
}

const DEFAULTS: Required<ConversationOptions> = {
  includeThinking: false,
  includeTools: true,
  includeNotes: true,
};

/**
 * Bookkeeping worth showing between turns. Everything else — an agent being
 * activated, a status change, a message event that duplicates the message
 * itself — is timeline material, not conversation.
 */
const NOTE_EVENTS = new Set<RunEventType>([
  'task_started',
  'task_completed',
  'task_failed',
  'task_blocked',
  'task_review_requested',
  'run_paused',
  'run_resumed',
  'run_failed',
  'run_cancelled',
  'budget_warning',
  'budget_exceeded',
  'error',
]);

function time(value: Date | string | undefined): string {
  if (!value) return new Date(0).toISOString();
  return typeof value === 'string' ? value : value.toISOString();
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** One line describing a tool call, without needing its arguments open. */
export function describeToolCallArgs(name: string, input: Record<string, unknown> = {}): string {
  const first =
    str(input.command) ??
    str(input.file_path) ??
    str(input.path) ??
    str(input.url) ??
    str(input.pattern) ??
    str(input.question) ??
    str(input.summary) ??
    str(input.title) ??
    str(input.to);
  return first ? `${name}: ${first}` : name;
}

/**
 * Builds the conversation.
 *
 * Rules, all of them deliberate:
 * - your objective opens it, and the run's summary closes it;
 * - an agent's output is a turn with its **full** text;
 * - tool calls are folded into the turn that follows them, by the same agent,
 *   because "it ran three commands and then said this" is one thought;
 * - agent-to-agent messages come from the messages themselves, not from the
 *   events that announce them, so the body is complete and nothing is doubled;
 * - a question and its answer are two turns, from the questions record, so the
 *   options offered survive;
 * - everything else that matters is a note, and everything that does not is
 *   left to the timeline.
 */
export function buildConversation(input: {
  run: ConversationRunInput;
  events: ConversationEventInput[];
  messages?: ConversationMessageInput[];
  questions?: ConversationQuestionInput[];
  agents?: ConversationAgentInput[];
  options?: ConversationOptions;
}): ConversationTurn[] {
  const opts = { ...DEFAULTS, ...(input.options ?? {}) };
  const handles = new Map((input.agents ?? []).map((a) => [a.id, a.handle]));
  const nameOf = (id?: string) => (id === 'user' ? 'you' : id ? (handles.get(id) ?? id) : undefined);

  const turns: Array<ConversationTurn & { order: number }> = [];
  let order = 0;
  const push = (turn: ConversationTurn) => {
    turns.push({ ...turn, order: order++ });
    return turns[turns.length - 1]!;
  };

  push({
    id: 'objective',
    kind: 'objective',
    speaker: 'you',
    speakerId: 'user',
    text: input.run.objective,
    tone: 'info',
    at: time(input.run.createdAt),
    tools: [],
  });

  // Tool calls and thinking wait for the turn they belong to.
  const pendingTools = new Map<string, ConversationToolCall[]>();
  const pendingThinking = new Map<string, string[]>();
  const lastTurnOfAgent = new Map<string, ConversationTurn>();

  const ordered = [...input.events].sort((a, b) => a.seq - b.seq);

  for (const event of ordered) {
    const agentKey = event.agentId ?? '—';

    if (event.type === 'tool_call') {
      if (!opts.includeTools) continue;
      const name = str(event.data?.toolName) ?? 'tool';
      const args = (event.data?.input ?? {}) as Record<string, unknown>;
      const list = pendingTools.get(agentKey) ?? [];
      list.push({
        id: event.id,
        ...(str(event.data?.toolCallId) ? { callId: str(event.data?.toolCallId) } : {}),
        name,
        detail: describeToolCallArgs(name, args),
        input: args,
      });
      pendingTools.set(agentKey, list);
      continue;
    }

    if (event.type === 'tool_result') {
      if (!opts.includeTools) continue;
      const callId = str(event.data?.toolCallId);
      const candidates = [...(pendingTools.get(agentKey) ?? [])].reverse();
      // Pair by the provider's call id; without one, the newest call still
      // waiting for a result is the only honest guess.
      const target = callId
        ? candidates.find((tool) => tool.callId === callId)
        : candidates.find((tool) => tool.result === undefined);
      if (target) {
        target.result = str(event.data?.summary);
        target.isError = event.data?.isError === true;
      }
      continue;
    }

    if (event.type === 'agent_thinking') {
      const text = str(event.data?.text);
      if (!text) continue;
      const list = pendingThinking.get(agentKey) ?? [];
      list.push(text);
      pendingThinking.set(agentKey, list);
      continue;
    }

    if (event.type === 'agent_output') {
      const text = str(event.data?.text) ?? event.summary;
      const thinking = pendingThinking.get(agentKey);
      const turn = push({
        id: event.id,
        kind: 'say',
        speaker: nameOf(event.agentId) ?? 'agent',
        speakerId: event.agentId,
        text,
        tone: 'neutral',
        at: time(event.createdAt),
        taskId: event.taskId,
        model: event.model,
        effort: event.effort,
        costUsd: event.costUsd,
        durationMs: event.durationMs,
        seq: event.seq,
        tools: pendingTools.get(agentKey) ?? [],
        ...(opts.includeThinking && thinking?.length ? { thinking: thinking.join('\n\n') } : {}),
      });
      pendingTools.delete(agentKey);
      pendingThinking.delete(agentKey);
      lastTurnOfAgent.set(agentKey, turn);
      continue;
    }

    if (event.type === 'approval_requested' || event.type === 'approval_resolved') {
      push({
        id: event.id,
        kind: 'approval',
        speaker: event.type === 'approval_requested' ? nameOf(event.agentId) : 'you',
        speakerId: event.type === 'approval_requested' ? event.agentId : 'user',
        text: event.summary,
        tone: event.type === 'approval_requested' ? 'warning' : 'success',
        at: time(event.createdAt),
        taskId: event.taskId,
        seq: event.seq,
        tools: [],
      });
      continue;
    }

    if (opts.includeNotes && NOTE_EVENTS.has(event.type)) {
      push({
        id: event.id,
        kind: 'note',
        speaker: nameOf(event.agentId),
        speakerId: event.agentId,
        text: event.summary,
        tone: event.level === 'error' ? 'danger' : event.level === 'warn' ? 'warning' : 'muted',
        at: time(event.createdAt),
        taskId: event.taskId,
        seq: event.seq,
        failed: event.level === 'error',
        tools: [],
      });
    }
  }

  // Tools an agent ran without ever speaking afterwards still happened.
  for (const [agentKey, tools] of pendingTools) {
    if (tools.length === 0) continue;
    const last = lastTurnOfAgent.get(agentKey);
    if (last) last.tools = [...last.tools, ...tools];
    else {
      push({
        id: `tools-${agentKey}`,
        kind: 'note',
        speaker: nameOf(agentKey === '—' ? undefined : agentKey),
        speakerId: agentKey === '—' ? undefined : agentKey,
        text: `used ${tools.length} tool(s) without producing output`,
        tone: 'muted',
        at: time(new Date(0)),
        tools,
      });
    }
  }

  for (const message of input.messages ?? []) {
    push({
      id: message.id,
      kind: 'message',
      speaker: nameOf(message.from) ?? message.from,
      speakerId: message.from,
      to: message.to.map((id) => nameOf(id) ?? id),
      text: message.content,
      tone: message.type === 'question' ? 'warning' : message.type === 'answer' ? 'success' : 'info',
      at: time(message.createdAt),
      taskId: message.taskId,
      seq: message.seq,
      messageType: message.type,
      messageStatus: message.status,
      tools: [],
    });
  }

  for (const question of input.questions ?? []) {
    push({
      id: question.id,
      kind: 'ask',
      speaker: nameOf(question.agentId) ?? 'agent',
      speakerId: question.agentId,
      text: question.header ? `${question.header}\n${question.question}` : question.question,
      tone: 'warning',
      at: time(question.createdAt),
      options: question.options,
      tools: [],
    });
    if (question.answer && question.status !== 'pending') {
      const auto = question.answeredBy === 'auto' || question.answeredBy === 'timeout';
      push({
        id: `${question.id}-answer`,
        kind: 'answer',
        speaker: auto ? 'auto mode' : 'you',
        speakerId: auto ? undefined : 'user',
        text: question.answer,
        tone: auto ? 'muted' : 'success',
        at: time(question.answeredAt ?? question.createdAt),
        tools: [],
      });
    }
  }

  if (input.run.summary) {
    push({
      id: 'result',
      kind: 'result',
      speaker: undefined,
      text: input.run.summary,
      tone: 'success',
      at: time(input.run.completedAt ?? new Date(8.64e15)),
      tools: [],
    });
  }

  if (input.run.error) {
    push({
      id: 'run-error',
      kind: 'note',
      text: input.run.error,
      tone: 'danger',
      failed: true,
      at: time(input.run.completedAt ?? new Date(8.64e15)),
      tools: [],
    });
  }

  return turns
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order))
    .map(({ order: _order, ...turn }) => turn);
}

/** Counts worth showing on the tab, without rendering anything. */
export function conversationSize(turns: ConversationTurn[]): {
  spoken: number;
  tools: number;
  decisions: number;
} {
  return {
    spoken: turns.filter((t) => t.kind === 'say' || t.kind === 'message').length,
    tools: turns.reduce((sum, turn) => sum + turn.tools.length, 0),
    decisions: turns.filter((t) => t.kind === 'ask' || t.kind === 'approval').length,
  };
}
