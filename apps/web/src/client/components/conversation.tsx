import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunDetailDto } from '@claude-team/protocol';
import { formatUsd } from '@claude-team/domain';
import {
  buildConversation,
  formatClock,
  formatDuration,
  type ConversationTurn,
  type ConversationToolCall,
} from '@claude-team/ui-shared';
import { toneClass } from '../lib/tone';
import { EffortBadge, EmptyState, ModelBadge } from './ui';

/**
 * The run as a conversation: what each agent actually said, in full.
 *
 * The timeline stays as the log — one line per event, with costs and types —
 * and this is the reading view. Which turns exist and what folds into them is
 * decided in `@claude-team/ui-shared`; this file only renders.
 */

export interface ConversationPrefs {
  tools: boolean;
  thinking: boolean;
  notes: boolean;
}

export const DEFAULT_CONVERSATION_PREFS: ConversationPrefs = {
  tools: true,
  thinking: false,
  notes: true,
};

/** A stable colour per speaker, so an agent looks the same all the way down. */
function hueOf(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return hash;
}

export function Conversation({
  data,
  prefs,
  onPrefsChange,
  live,
}: {
  data: RunDetailDto;
  prefs: ConversationPrefs;
  onPrefsChange: (prefs: ConversationPrefs) => void;
  live?: boolean;
}) {
  const turns = useMemo(
    () =>
      buildConversation({
        run: data.run,
        events: data.events,
        messages: data.messages,
        questions: data.questions,
        agents: data.agents,
        options: {
          includeTools: prefs.tools,
          includeThinking: prefs.thinking,
          includeNotes: prefs.notes,
        },
      }),
    [data, prefs],
  );

  const scroller = useRef<HTMLDivElement | null>(null);
  // A finished run is a document: it opens at the beginning, where the
  // objective is. A live one is a feed: it sticks to the newest turn — until
  // the reader scrolls up to read something, at which point yanking them back
  // down is hostile.
  const [following, setFollowing] = useState(Boolean(live));

  useEffect(() => {
    if (!following) return;
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns, following]);

  const onScroll = () => {
    const node = scroller.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
    setFollowing(atBottom);
  };

  const toggle = (key: keyof ConversationPrefs) =>
    onPrefsChange({ ...prefs, [key]: !prefs[key] });

  return (
    <div className="chat">
      <div className="chat-controls">
        {(
          [
            ['tools', 'Tool calls'],
            ['thinking', 'Reasoning'],
            ['notes', 'Task notes'],
          ] as Array<[keyof ConversationPrefs, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="chip"
            aria-pressed={prefs[key]}
            onClick={() => toggle(key)}
          >
            {label}
          </button>
        ))}
        <span className="right tiny muted">
          {turns.filter((t) => t.kind === 'say' || t.kind === 'message').length} turn(s)
        </span>
      </div>

      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        {turns.length === 0 ? (
          <EmptyState
            title="Nothing said yet"
            description="Agent output, messages between agents and anything they ask you appear here as the run goes."
          />
        ) : (
          turns.map((turn) => <Turn key={turn.id} turn={turn} />)
        )}
      </div>

      {live && !following && (
        <button
          type="button"
          className="btn btn-sm chat-jump"
          onClick={() => {
            setFollowing(true);
            const node = scroller.current;
            if (node) node.scrollTop = node.scrollHeight;
          }}
        >
          Jump to latest ↓
        </button>
      )}
    </div>
  );
}

function Turn({ turn }: { turn: ConversationTurn }) {
  if (turn.kind === 'note') {
    return (
      <div className={`chat-note ${toneClass(turn.tone)}`}>
        <span className="ts">{formatClock(turn.at)}</span>
        <span className="line" />
        <span className="what">
          {turn.speaker ? <strong>{turn.speaker}</strong> : null} {turn.text}
        </span>
      </div>
    );
  }

  const mine = turn.kind === 'objective' || turn.kind === 'answer';
  const hue = turn.speaker && !mine ? hueOf(turn.speaker) : undefined;

  return (
    <article
      className={`chat-turn ${toneClass(turn.tone)}${mine ? ' from-user' : ''} kind-${turn.kind}`}
      style={hue === undefined ? undefined : ({ '--who': `${hue}` } as React.CSSProperties)}
    >
      <header className="chat-head">
        <span className="who">
          {turn.kind === 'result' ? 'Result' : (turn.speaker ?? 'run')}
          {turn.to?.length ? <span className="muted"> → {turn.to.join(', ')}</span> : null}
        </span>
        {turn.kind === 'ask' && <span className="badge tone-warning">asked you</span>}
        {turn.messageType && <span className="badge">{turn.messageType}</span>}
        {turn.model && <ModelBadge model={turn.model} />}
        {turn.effort && <EffortBadge effort={turn.effort} />}
        <span className="right tiny muted">
          {turn.durationMs !== undefined && `${formatDuration(turn.durationMs)} · `}
          {turn.costUsd ? `${formatUsd(turn.costUsd)} · ` : ''}
          {formatClock(turn.at)}
        </span>
      </header>

      {turn.thinking && (
        <details className="chat-thinking">
          <summary>Reasoning</summary>
          <div className="body">{turn.thinking}</div>
        </details>
      )}

      {turn.tools.length > 0 && <Tools tools={turn.tools} />}

      <div className="body">{turn.text}</div>

      {turn.options && turn.options.length > 0 && (
        <ul className="chat-options">
          {turn.options.map((option) => (
            <li key={option.label}>
              <strong>{option.label}</strong>
              {option.description ? <span className="muted"> — {option.description}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/** Tool calls are context for the turn, not the turn itself: folded by default. */
function Tools({ tools }: { tools: ConversationToolCall[] }) {
  return (
    <details className="chat-tools">
      <summary>
        {tools.length} tool call{tools.length === 1 ? '' : 's'}
        <span className="muted"> — {tools.map((tool) => tool.name).join(', ')}</span>
      </summary>
      <ul>
        {tools.map((tool) => (
          <li key={tool.id} className={tool.isError ? 'tone-danger' : undefined}>
            <span className="mono">{tool.detail}</span>
            {tool.result && <span className="muted"> → {tool.result}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
