import { describe, expect, it } from 'vitest';
import {
  buildConversation,
  conversationSize,
  describeToolCallArgs,
  type ConversationEventInput,
} from './conversation.js';

/**
 * The conversation is what people read; the timeline is what they consult.
 * These assertions are about that difference: full bodies, correct order, and
 * nothing shown twice.
 */

const AGENTS = [
  { id: 'ag_lead', handle: 'head' },
  { id: 'ag_writer', handle: 'redator' },
];

const RUN = {
  objective: 'Escrever uma página de nicho',
  createdAt: '2026-08-18T10:00:00.000Z',
  completedAt: '2026-08-18T10:05:00.000Z',
  summary: 'Página escrita e revisada.',
};

const LONG_TEXT = `Primeiro parágrafo com bastante conteúdo.\n\nSegundo parágrafo, ainda mais longo, ${'x'.repeat(400)}`;

function event(partial: Partial<ConversationEventInput> & { seq: number }): ConversationEventInput {
  return {
    id: `ev_${partial.seq}`,
    type: 'agent_output',
    summary: 'summary',
    level: 'info',
    createdAt: `2026-08-18T10:0${partial.seq}:00.000Z`,
    ...partial,
  };
}

describe('a run read as a conversation', () => {
  it('opens with your objective and closes with the result', () => {
    const turns = buildConversation({ run: RUN, events: [], agents: AGENTS });

    expect(turns[0]).toMatchObject({ kind: 'objective', speaker: 'you', text: RUN.objective });
    expect(turns[turns.length - 1]).toMatchObject({ kind: 'result', text: RUN.summary });
  });

  it('carries the whole body of what an agent said, not the summary', () => {
    const turns = buildConversation({
      run: RUN,
      agents: AGENTS,
      events: [
        event({
          seq: 1,
          agentId: 'ag_writer',
          summary: 'redator: Primeiro parágrafo com bastante…',
          data: { text: LONG_TEXT },
          model: 'sonnet',
          effort: 'medium',
        }),
      ],
    });

    const say = turns.find((t) => t.kind === 'say')!;
    expect(say.text).toBe(LONG_TEXT);
    expect(say.text).not.toMatch(/…$/);
    expect(say).toMatchObject({ speaker: 'redator', model: 'sonnet', effort: 'medium' });
  });

  it('folds tool calls into the turn they led to, with their results', () => {
    const turns = buildConversation({
      run: RUN,
      agents: AGENTS,
      events: [
        event({
          seq: 1,
          type: 'tool_call',
          agentId: 'ag_writer',
          data: { toolName: 'Read', input: { file_path: '/tmp/brief.md' }, toolCallId: 'c1' },
        }),
        event({
          seq: 2,
          type: 'tool_result',
          agentId: 'ag_writer',
          data: { summary: '42 lines', toolCallId: 'c1' },
        }),
        event({ seq: 3, agentId: 'ag_writer', data: { text: 'Li o briefing.' } }),
      ],
    });

    const say = turns.find((t) => t.kind === 'say')!;
    expect(say.tools).toHaveLength(1);
    expect(say.tools[0]).toMatchObject({ name: 'Read', detail: 'Read: /tmp/brief.md', result: '42 lines' });
    // The tool call is not also a turn of its own.
    expect(turns.filter((t) => t.text.includes('/tmp/brief.md'))).toHaveLength(0);
  });

  it('keeps tools an agent ran without ever speaking', () => {
    const turns = buildConversation({
      run: { ...RUN, summary: undefined },
      agents: AGENTS,
      events: [
        event({ seq: 1, type: 'tool_call', agentId: 'ag_lead', data: { toolName: 'create_tasks', input: {} } }),
      ],
    });

    expect(turns.some((t) => t.tools.some((tool) => tool.name === 'create_tasks'))).toBe(true);
  });

  it('can leave tools out entirely', () => {
    const turns = buildConversation({
      run: RUN,
      agents: AGENTS,
      events: [
        event({ seq: 1, type: 'tool_call', agentId: 'ag_writer', data: { toolName: 'Read', input: {} } }),
        event({ seq: 2, agentId: 'ag_writer', data: { text: 'pronto' } }),
      ],
      options: { includeTools: false },
    });

    expect(turns.flatMap((t) => t.tools)).toEqual([]);
  });

  it('shows an agent-to-agent message once, with its full body', () => {
    const body = 'Preciso do briefing completo antes de escrever.';
    const turns = buildConversation({
      run: RUN,
      agents: AGENTS,
      events: [
        // The event that announces the message must not become a second turn.
        event({ seq: 1, type: 'message_sent', agentId: 'ag_writer', summary: 'redator → head: Preciso do…' }),
      ],
      messages: [
        {
          id: 'ms_1',
          seq: 1,
          from: 'ag_writer',
          to: ['ag_lead'],
          type: 'question',
          content: body,
          status: 'completed',
          createdAt: '2026-08-18T10:01:30.000Z',
        },
      ],
    });

    const messages = turns.filter((t) => t.kind === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ speaker: 'redator', to: ['head'], text: body });
    expect(turns.filter((t) => t.text.includes('Preciso do'))).toHaveLength(1);
  });

  it('renders a question and its answer as two turns, keeping the options offered', () => {
    const turns = buildConversation({
      run: RUN,
      agents: AGENTS,
      events: [
        // Same rule as messages: the events are timeline material.
        event({ seq: 1, type: 'question_asked', agentId: 'ag_lead', summary: 'head is asking you: qual nicho?' }),
        event({ seq: 2, type: 'question_answered', agentId: 'ag_lead', summary: 'You answered: Casamentos' }),
      ],
      questions: [
        {
          id: 'qs_1',
          agentId: 'ag_lead',
          header: 'Nicho',
          question: 'Qual nicho atacar?',
          options: [
            { label: 'Casamentos', description: 'Ticket alto' },
            { label: 'Home office', description: 'Competitivo' },
          ],
          status: 'answered',
          answer: 'Chosen: Casamentos',
          answeredBy: 'user',
          createdAt: '2026-08-18T10:02:00.000Z',
          answeredAt: '2026-08-18T10:02:30.000Z',
        },
      ],
    });

    const ask = turns.find((t) => t.kind === 'ask')!;
    const answer = turns.find((t) => t.kind === 'answer')!;
    expect(ask.text).toContain('Qual nicho atacar?');
    expect(ask.options?.map((o) => o.label)).toEqual(['Casamentos', 'Home office']);
    expect(ask.speaker).toBe('head');
    expect(answer).toMatchObject({ speaker: 'you', text: 'Chosen: Casamentos' });
    // Asked before answered, whatever order they arrived in.
    expect(turns.indexOf(ask)).toBeLessThan(turns.indexOf(answer));
  });

  it('says when auto mode answered instead of you', () => {
    const turns = buildConversation({
      run: RUN,
      agents: AGENTS,
      events: [],
      questions: [
        {
          id: 'qs_1',
          agentId: 'ag_lead',
          question: 'Qual nicho?',
          options: [],
          status: 'skipped',
          answer: 'Decide it yourself…',
          answeredBy: 'auto',
          createdAt: '2026-08-18T10:02:00.000Z',
          answeredAt: '2026-08-18T10:02:00.000Z',
        },
      ],
    });

    expect(turns.find((t) => t.kind === 'answer')).toMatchObject({ speaker: 'auto mode' });
  });

  it('orders everything by when it happened, whatever source it came from', () => {
    const turns = buildConversation({
      run: RUN,
      agents: AGENTS,
      events: [event({ seq: 5, agentId: 'ag_lead', data: { text: 'terceiro' }, createdAt: '2026-08-18T10:03:00.000Z' })],
      messages: [
        {
          id: 'ms_1',
          seq: 1,
          from: 'ag_writer',
          to: ['ag_lead'],
          type: 'message',
          content: 'segundo',
          status: 'completed',
          createdAt: '2026-08-18T10:02:00.000Z',
        },
      ],
      questions: [
        {
          id: 'qs_1',
          agentId: 'ag_lead',
          question: 'primeiro',
          options: [],
          status: 'pending',
          createdAt: '2026-08-18T10:01:00.000Z',
        },
      ],
    });

    expect(turns.map((t) => t.text.split('\n')[0])).toEqual([
      RUN.objective,
      'primeiro',
      'segundo',
      'terceiro',
      RUN.summary,
    ]);
  });

  it('demotes bookkeeping to notes, and can drop it', () => {
    const events = [
      event({ seq: 1, type: 'task_started', agentId: 'ag_writer', summary: 'Started: escrever' }),
      event({ seq: 2, type: 'agent_status_changed', agentId: 'ag_writer', summary: 'redator is working' }),
      event({ seq: 3, agentId: 'ag_writer', data: { text: 'feito' } }),
    ];

    const withNotes = buildConversation({ run: RUN, agents: AGENTS, events });
    expect(withNotes.filter((t) => t.kind === 'note').map((t) => t.text)).toEqual(['Started: escrever']);
    // A status change is never conversation.
    expect(withNotes.some((t) => t.text.includes('is working'))).toBe(false);

    const quiet = buildConversation({ run: RUN, agents: AGENTS, events, options: { includeNotes: false } });
    expect(quiet.some((t) => t.kind === 'note')).toBe(false);
  });

  it('hides reasoning unless it is asked for', () => {
    const events = [
      event({ seq: 1, type: 'agent_thinking', agentId: 'ag_writer', level: 'debug', data: { text: 'pensando alto' } }),
      event({ seq: 2, agentId: 'ag_writer', data: { text: 'a resposta' } }),
    ];

    expect(buildConversation({ run: RUN, agents: AGENTS, events }).find((t) => t.kind === 'say')?.thinking)
      .toBeUndefined();
    expect(
      buildConversation({ run: RUN, agents: AGENTS, events, options: { includeThinking: true } }).find(
        (t) => t.kind === 'say',
      )?.thinking,
    ).toBe('pensando alto');
  });

  it('shows the error of a failed run where the reader is already looking', () => {
    const turns = buildConversation({
      run: { ...RUN, summary: undefined, error: 'provider exploded' },
      agents: AGENTS,
      events: [],
    });

    expect(turns.some((t) => t.failed && t.text === 'provider exploded')).toBe(true);
  });

  it('counts what is in it, for the tab label', () => {
    const turns = buildConversation({
      run: RUN,
      agents: AGENTS,
      events: [
        event({ seq: 1, type: 'tool_call', agentId: 'ag_writer', data: { toolName: 'Read', input: {} } }),
        event({ seq: 2, agentId: 'ag_writer', data: { text: 'ok' } }),
        event({ seq: 3, type: 'approval_requested', agentId: 'ag_writer', summary: 'Approval needed' }),
      ],
    });

    expect(conversationSize(turns)).toMatchObject({ spoken: 1, tools: 1, decisions: 1 });
  });

  it('describes a tool call by what it acts on', () => {
    expect(describeToolCallArgs('Bash', { command: 'ls -la' })).toBe('Bash: ls -la');
    expect(describeToolCallArgs('Write', { file_path: '/tmp/a.md' })).toBe('Write: /tmp/a.md');
    expect(describeToolCallArgs('finish', {})).toBe('finish');
  });
});
