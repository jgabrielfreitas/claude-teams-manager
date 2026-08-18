import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { TRANSCRIPT_FORMATS } from '@claude-team/core';
import { formatTokens, formatUsd, totalTokens } from '@claude-team/domain';
import {
  RUN_STATUS_UI,
  buildConversation,
  formatDuration,
  runDurationMs,
  truncate,
} from '@claude-team/ui-shared';
import { toneColor, UI } from '../theme.js';
import { useKeys, useLoader } from '../lib/hooks.js';
import { useUi } from '../store.js';
import { copyRunTranscript, exportRunTranscript } from '../actions.js';
import { Dim, EmptyState, ErrorLine, KeyHints, Loading, StatusChip } from '../components/ui.js';
import { EventRow, ProgressLine, TaskRow, conversationLines } from '../components/rows.js';

/**
 * One run, using the whole terminal.
 *
 * The two-pane layout is right for choosing a run and wrong for reading one:
 * a timeline of a hundred events in a third of the screen is a keyhole. This
 * view drops the list and the panels, keeps a two-line header, and gives every
 * remaining row to the content — with the copy and export of the *same*
 * transcript the browser downloads a keypress away.
 */

// Conversation first: it is what the run *said*, and the timeline is the log
// you consult when the reading view is not enough.
const TABS = ['conversation', 'tasks', 'timeline'] as const;
type Tab = (typeof TABS)[number];

const TAB_LABEL: Record<Tab, string> = {
  conversation: 'Conversation',
  timeline: 'Timeline',
  tasks: 'Tasks',
};

/** Used once the full names plus their counts no longer fit on one line. */
const TAB_SHORT: Record<Tab, string> = {
  conversation: 'Talk',
  timeline: 'Time',
  tasks: 'Task',
};

export interface RunFullScreenProps {
  /** Rows available to the view, chrome included. */
  height: number;
  columns: number;
  narrow: boolean;
}

export function RunFullScreen({ height, columns, narrow }: RunFullScreenProps): React.JSX.Element {
  const ui = useUi();
  const runId = ui.selection.runId;
  const revision = ui.rev(['runs', 'events', 'messages']);
  const { data, error, loading } = useLoader(
    async () => (runId ? ui.core.getRunDetail(runId) : undefined),
    [runId, revision],
  );

  const [tab, setTab] = useState<Tab>('conversation');
  const [offset, setOffset] = useState(0);
  /** Live runs stick to the newest row until the user scrolls up. */
  const [follow, setFollow] = useState(true);

  // Another run, or another tab, is another document: start at its end again.
  useEffect(() => {
    setOffset(0);
    setFollow(true);
  }, [runId, tab]);

  // Memoised because the conversation is rebuilt from them: a fresh `[]` on
  // every render would rebuild it on every render too.
  const events = useMemo(() => data?.events ?? [], [data]);
  const tasks = data?.tasks ?? [];
  const messages = useMemo(() => data?.messages ?? [], [data]);
  const agents = useMemo(() => data?.agents ?? [], [data]);

  const handleOf = useMemo(
    () => (agentId?: string) => agents.find((agent) => agent.id === agentId)?.handle,
    [agents],
  );
  const nameOf = useMemo(
    () => (id: string) => (id === 'user' ? 'user' : (handleOf(id) ?? id)),
    [handleOf],
  );

  // The timeline hides debug events unless asked for — the same rule the
  // transcript applies, so what is on screen is what `y` and `e` produce.
  const visibleEvents = ui.transcript.includeDebug
    ? events
    : events.filter((event) => event.level !== 'debug');

  const rows: React.ReactNode[] = useMemo(() => {
    switch (tab) {
      case 'conversation':
        return conversationLines(
          buildConversation({
            run: data?.run ?? { objective: '', createdAt: new Date() },
            events,
            messages,
            questions: data?.questions ?? [],
            agents,
            // Reasoning follows the same switch as the transcript: what is on
            // screen is what `y` and `e` produce.
            options: { includeThinking: ui.transcript.includeDebug },
          }),
          columns,
        );
      case 'tasks':
        return tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            agentHandle={handleOf(task.assignedAgentId)}
            dependencyTitles={task.dependencies.map(
              (id) => tasks.find((candidate) => candidate.id === id)?.title ?? id,
            )}
          />
        ));
      default:
        return visibleEvents.map((event) => (
          <EventRow key={event.id} event={event} handle={handleOf(event.agentId)} />
        ));
    }
    // `visibleEvents` is derived from `events` on every render; depending on the
    // arrays it is built from keeps this memo honest without re-running per key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, tasks, messages, events, data, agents, columns, ui.transcript.includeDebug, handleOf, nameOf]);

  // What the tab bar counts: turns spoken, not rows rendered — a long answer
  // is one turn however many lines it wraps to.
  const conversationTurns = useMemo(
    () =>
      buildConversation({
        run: data?.run ?? { objective: '', createdAt: new Date() },
        events,
        messages,
        questions: data?.questions ?? [],
        agents,
      }).filter((turn) => turn.kind === 'say' || turn.kind === 'message').length,
    [data, events, messages, agents],
  );

  // Header, tab bar and key legend; each one is dropped before the content is,
  // so an eight-row terminal still shows the run rather than crashing.
  const headerRows = height >= 12 ? 3 : height >= 8 ? 2 : 1;
  const footerRows = height >= 8 ? 1 : 0;
  const viewport = Math.max(1, height - headerRows - footerRows - 1);

  const maxOffset = Math.max(0, rows.length - viewport);
  const top = follow ? maxOffset : Math.min(offset, maxOffset);

  const scrollTo = (next: number) => {
    const clamped = Math.max(0, Math.min(maxOffset, next));
    setOffset(clamped);
    // Reaching the end is the same intent as pressing G.
    setFollow(clamped >= maxOffset);
  };

  useKeys(
    (input, key) => {
      if (key.escape || input === 'q') {
        ui.setRunFullScreen(false);
        return;
      }
      if (input === 't' || key.tab || key.rightArrow) {
        setTab(TABS[(TABS.indexOf(tab) + 1) % TABS.length]);
        return;
      }
      if (key.leftArrow) {
        setTab(TABS[(TABS.indexOf(tab) + TABS.length - 1) % TABS.length]);
        return;
      }
      if (key.upArrow || input === 'k') {
        setFollow(false);
        setOffset(Math.max(0, top - 1));
        return;
      }
      if (key.downArrow || input === 'j') {
        scrollTo(top + 1);
        return;
      }
      if (key.pageUp) {
        setFollow(false);
        setOffset(Math.max(0, top - viewport));
        return;
      }
      if (key.pageDown) {
        scrollTo(top + viewport);
        return;
      }
      if (input === 'g') {
        setFollow(false);
        setOffset(0);
        return;
      }
      if (input === 'G' || input === 'f') {
        setFollow(true);
        return;
      }
      if (input === 'F') {
        const position = TRANSCRIPT_FORMATS.indexOf(ui.transcript.format);
        ui.setTranscriptFormat(TRANSCRIPT_FORMATS[(position + 1) % TRANSCRIPT_FORMATS.length]);
        return;
      }
      if (input === 'D') {
        ui.setTranscriptIncludeDebug(!ui.transcript.includeDebug);
        return;
      }
      if (input === 'y') ui.dispatch(() => copyRunTranscript(ui));
      else if (input === 'e') ui.dispatch(() => exportRunTranscript(ui));
    },
    ui.lock === 'view',
  );

  if (!runId) {
    return (
      <Box flexDirection="column" width={columns}>
        <EmptyState title="No run selected." hints={['press esc to go back to the run list']} />
      </Box>
    );
  }
  if (error) return <ErrorLine message={error} />;
  if (!data) {
    return loading ? <Loading label="Loading run" /> : <EmptyState title="Nothing to show." />;
  }

  const { run, team, progress } = data;
  const status = RUN_STATUS_UI[run.status];
  const slice = rows.slice(top, top + viewport);
  // Two steps of degradation for the tab bar, so it clips instead of wrapping.
  const compact = columns < 58;
  const tiny = columns < 34;

  const totals =
    `${formatTokens(totalTokens(run.totals.usage))} tokens · ${formatUsd(run.totals.costUsd)}` +
    ` · ${formatDuration(runDurationMs(run))} · ${run.totals.agentActivations} activations` +
    ` · ${run.totals.toolCalls} tools · ${run.totals.messages} msgs`;

  return (
    <Box flexDirection="column" width={columns} height={height}>
      {/* ---- header ---- */}
      <Box overflow="hidden">
        {/* The label goes before the objective does: at 20 columns a wrapped
            status word would cost the tab bar its row. */}
        <StatusChip status={status} showLabel={!tiny} />
        <Text bold wrap="truncate-end">
          {`  ${truncate(run.objective, Math.max(12, columns - (tiny ? 4 : 30)))}`}
        </Text>
      </Box>
      {headerRows >= 2 ? (
        <Box overflow="hidden">
          {/* The bar keeps its width; the totals after it are what gets cut. */}
          <Box flexShrink={0}>
            <ProgressLine
              percent={progress.percent}
              width={narrow ? 10 : 18}
              label={`${progress.completed}/${progress.total} tasks`}
            />
          </Box>
          <Text color={UI.dim} wrap="truncate-end">
            {`  ${totals}`}
          </Text>
        </Box>
      ) : null}
      {headerRows >= 3 ? (
        <Box>
          <Text color={UI.dim} wrap="truncate-end">
            {`${team.name} · ${run.id}`}
          </Text>
        </Box>
      ) : null}

      {/* ---- tab bar: names, then names without counts, then short names ---- */}
      <Box overflow="hidden">
        {TABS.map((candidate) => {
          const active = candidate === tab;
          const count =
            candidate === 'tasks'
              ? tasks.length
              : candidate === 'conversation'
                ? conversationTurns
                : visibleEvents.length;
          const label = tiny ? TAB_SHORT[candidate] : TAB_LABEL[candidate];
          return (
            <Text key={candidate}>
              <Text
                color={active ? 'black' : UI.dim}
                backgroundColor={active ? UI.accent : undefined}
                bold={active}
              >
                {` ${label}${compact ? '' : ` ${count}`} `}
              </Text>
              {tiny ? null : <Text> </Text>}
            </Text>
          );
        })}
        {tiny ? null : <Box flexGrow={1} />}
        <Text color={toneColor(follow ? 'active' : 'muted')}>
          {follow ? (tiny ? '⇣' : '⇣ following') : tiny ? '⏸' : '⏸ paused'}
        </Text>
        {!compact && rows.length > viewport ? (
          <Text color={UI.dim}>{`  ${Math.min(top + viewport, rows.length)}/${rows.length}`}</Text>
        ) : null}
      </Box>

      {/* ---- content ---- */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {rows.length === 0 ? <Dim>{`No ${tab} yet.`}</Dim> : slice}
      </Box>

      {/* ---- footer ---- */}
      {footerRows > 0 ? (
        <Box>
          <KeyHints
            hints={[
              { key: 't', label: 'tab' },
              { key: '↑↓', label: 'scroll' },
              { key: 'g/G', label: 'top/end' },
              { key: 'f', label: 'follow' },
              { key: 'F', label: `format: ${ui.transcript.format}` },
              { key: 'D', label: `debug: ${ui.transcript.includeDebug ? 'on' : 'off'}` },
              { key: 'y', label: 'copy' },
              { key: 'e', label: 'export' },
              { key: 'esc', label: 'back' },
            ]}
          />
        </Box>
      ) : null}
    </Box>
  );
}
