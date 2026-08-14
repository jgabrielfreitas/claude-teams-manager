import { useMemo } from 'react';
import type { AgentDto, MessageDto, RunEventDto, TaskDto, TaskProgressDto } from '@claude-team/protocol';
import { isRunTerminal, taskProgress, type RunStatus, type Task } from '@claude-team/domain';
import {
  eventTone,
  formatClock,
  formatDuration,
  formatRelative,
  truncate,
} from '@claude-team/ui-shared';
import { formatTokens, formatUsd } from '@claude-team/domain';
import { client } from '../api';
import { useResource } from '../hooks/use-resource';
import { eventTouchesRun } from '@claude-team/protocol';
import { messageStatusUi, messageTypeUi, taskStatusUi, toneClass } from '../lib/tone';
import { AgentInline } from './agent-views';
import { EmptyState, ProgressBar, StatusPill } from './ui';

/* ------------------------------------------------------------------ *
 * Timeline
 * ------------------------------------------------------------------ */

export function Timeline({
  events,
  agents,
  emptyLabel = 'No activity yet.',
  highlightId,
}: {
  events: RunEventDto[];
  agents: AgentDto[];
  emptyLabel?: string;
  highlightId?: string;
}) {
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  if (events.length === 0) return <EmptyState title={emptyLabel} />;

  return (
    <div className="timeline">
      {events.map((event) => {
        const tone = eventTone(event.type, event.level);
        const agent = event.agentId ? byId.get(event.agentId) : undefined;
        return (
          <div
            key={event.id}
            className={`timeline-row ${toneClass(tone)}${highlightId === event.id ? ' highlight' : ''}`}
          >
            <span className="ts" title={new Date(event.createdAt).toLocaleString()}>
              {formatClock(event.createdAt)}
            </span>
            <span className="who truncate">{agent?.handle ?? '—'}</span>
            <span className="what">
              <span className="type">{event.type}</span>
              {event.summary}
              {(event.model || event.durationMs !== undefined || event.costUsd !== undefined) && (
                <span className="tiny muted">
                  {'  '}
                  {event.model ? `· ${event.model}/${event.effort ?? '—'} ` : ''}
                  {event.durationMs !== undefined ? `· ${formatDuration(event.durationMs)} ` : ''}
                  {event.costUsd ? `· ${formatUsd(event.costUsd)}` : ''}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Task board (the DAG)
 * ------------------------------------------------------------------ */

export function TaskBoard({
  tasks,
  agents,
  focusTaskId,
}: {
  tasks: TaskDto[];
  agents: AgentDto[];
  focusTaskId?: string;
}) {
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  if (tasks.length === 0) {
    return (
      <EmptyState
        title="No tasks yet"
        description="The orchestrator creates the task graph once the run starts."
      />
    );
  }

  return (
    <div className="board">
      {tasks.map((task) => {
        const ui = taskStatusUi(task.status);
        return (
          <article
            key={task.id}
            id={`task-${task.id}`}
            className={`task ${toneClass(ui.tone)}`}
            style={focusTaskId === task.id ? { outline: '2px solid var(--tone)' } : undefined}
          >
            <div className="spread">
              <h4 className="truncate" title={task.title}>
                {task.title}
              </h4>
              <StatusPill status={ui} />
            </div>

            {task.description && <p className="small muted">{truncate(task.description, 180)}</p>}

            <div className="row small">
              <AgentInline agent={task.assignedAgentId ? byId.get(task.assignedAgentId) : undefined} />
              {task.reviewerAgentId && (
                <span className="tiny muted">
                  review: {byId.get(task.reviewerAgentId)?.handle ?? '—'}
                </span>
              )}
              {task.attempts > 1 && (
                <span className="tiny muted">
                  attempt {task.attempts}/{task.maxAttempts}
                </span>
              )}
            </div>

            {task.dependencies.length > 0 && (
              <div className="deps">
                <span>depends on</span>
                {task.dependencies.map((id) => (
                  <span key={id} className="badge">
                    {truncate(taskById.get(id)?.title ?? id, 28)}
                  </span>
                ))}
              </div>
            )}

            {task.error && <pre className="task-result tone-danger tone-text">{task.error}</pre>}
            {!task.error && task.result && <pre className="task-result">{task.result}</pre>}
          </article>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Conversation
 * ------------------------------------------------------------------ */

export function MessageThread({
  messages,
  agents,
}: {
  messages: MessageDto[];
  agents: AgentDto[];
}) {
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const nameOf = (id: string) => (id === 'user' ? 'you' : (byId.get(id)?.handle ?? id));

  if (messages.length === 0) {
    return (
      <EmptyState
        title="No messages"
        description="Agent-to-agent messages, questions and hand-offs appear here as the run progresses."
      />
    );
  }

  return (
    <div className="conversation">
      {messages.map((message) => {
        const type = messageTypeUi(message.type);
        return (
          <div
            key={message.id}
            className={`bubble ${toneClass(type.tone)}${message.from === 'user' ? ' from-user' : ''}`}
          >
            <div className="meta">
              <span className="strong tone-text">
                {type.glyph} {nameOf(message.from)} → {message.to.map(nameOf).join(', ')}
              </span>
              <span>#{message.seq}</span>
              <span>{type.label}</span>
              <span className="right">{formatRelative(message.createdAt)}</span>
              <StatusPill status={messageStatusUi(message.status)} />
            </div>
            <div className="body">{message.content}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Totals & progress
 * ------------------------------------------------------------------ */

/** The one rendering of a task-progress reading, wherever the numbers came from. */
export function TaskProgressSummary({ progress }: { progress: TaskProgressDto }) {
  return (
    <div className="col" style={{ gap: 5 }}>
      <ProgressBar percent={progress.percent} tone={progress.failed > 0 ? 'danger' : 'active'} />
      <span className="tiny muted">
        {progress.completed}/{progress.total} done
        {progress.running > 0 && ` · ${progress.running} running`}
        {progress.blocked > 0 && ` · ${progress.blocked} blocked`}
        {progress.failed > 0 && ` · ${progress.failed} failed`}
      </span>
    </div>
  );
}

export function TaskProgressBar({ tasks }: { tasks: TaskDto[] }) {
  // Shared rule, shared numbers: only `status` is read, so the DTO stands in
  // for the domain entity here.
  return <TaskProgressSummary progress={taskProgress(tasks as unknown as Task[])} />;
}

/**
 * Does this row have to fetch its own tasks and subscribe to the stream?
 *
 * Only when nobody handed it progress and the run can still change. The
 * dashboard passes the progress from its single payload (which it reloads on
 * every event), and a run in a terminal state will never move again — neither
 * is worth a request per row.
 */
export function needsLiveTasks(status: RunStatus, initial?: TaskProgressDto): boolean {
  return initial === undefined && !isRunTerminal(status);
}

/** Task progress for a run in a list. */
export function LiveRunProgress({
  runId,
  status,
  initial,
}: {
  runId: string;
  status: RunStatus;
  initial?: TaskProgressDto;
}) {
  const live = needsLiveTasks(status, initial);
  const tasks = useResource(
    () => (live ? client.getRunTasks(runId) : Promise.resolve(undefined)),
    [runId, live],
    live ? (event) => eventTouchesRun(event, runId) : undefined,
  );

  if (initial) return <TaskProgressSummary progress={initial} />;
  if (tasks.data) return <TaskProgressBar tasks={tasks.data} />;
  if (isRunTerminal(status)) {
    // Nothing was fetched — say what the run's own state already tells us.
    return (
      <ProgressBar
        percent={status === 'completed' ? 100 : 0}
        tone={status === 'failed' ? 'danger' : status === 'completed' ? 'success' : 'muted'}
      />
    );
  }
  return <ProgressBar percent={0} />;
}

export function RunTotals({
  totals,
}: {
  totals: {
    usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number };
    costUsd: number;
    agentActivations: number;
    toolCalls: number;
    messages: number;
  };
}) {
  const tokens =
    totals.usage.inputTokens +
    totals.usage.outputTokens +
    totals.usage.cacheCreationInputTokens +
    totals.usage.cacheReadInputTokens;

  return (
    <div className="row" style={{ gap: 18 }}>
      <Metric label="tokens" value={formatTokens(tokens)} />
      <Metric label="cost" value={formatUsd(totals.costUsd)} />
      <Metric label="activations" value={String(totals.agentActivations)} />
      <Metric label="tool calls" value={String(totals.toolCalls)} />
      <Metric label="messages" value={String(totals.messages)} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="col" style={{ gap: 0 }}>
      <span className="strong" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
      <span className="tiny muted">{label}</span>
    </span>
  );
}
