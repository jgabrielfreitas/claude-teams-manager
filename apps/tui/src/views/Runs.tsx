import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import {
  availableRunActions,
  formatTokens,
  formatUsd,
  shortModelLabel,
  totalTokens,
  type Run,
} from '@claude-team/domain';
import {
  EFFORT_UI,
  RUN_STATUS_UI,
  formatDuration,
  formatRelative,
  runDurationMs,
  truncate,
} from '@claude-team/ui-shared';
import { toneColor, UI } from '../theme.js';
import { useKeys, useListNav, useLoader, windowOf } from '../lib/hooks.js';
import { useUi } from '../store.js';
import {
  copyRunTranscript,
  exportRunTranscript,
  messageAgent,
  runAction,
  startRun,
} from '../actions.js';
import { TwoPane, type ViewProps } from '../components/Layout.js';
import {
  Dim,
  EmptyState,
  ErrorLine,
  Field,
  KeyHints,
  ListRow,
  Loading,
  MoreRow,
  SectionTitle,
  StatusChip,
} from '../components/ui.js';
import { EventRow, ProgressLine, RunRow, TaskRow } from '../components/rows.js';

export function RunsView({ height, columns, narrow }: ViewProps): React.JSX.Element {
  const ui = useUi();
  const revision = ui.rev(['runs', 'events']);
  const { data, error, loading } = useLoader(
    async () => ({ runs: await ui.core.listRuns({ limit: 100 }) }),
    [revision],
  );

  const runs: Run[] = data?.runs ?? [];
  const listActive = ui.lock === 'view' && ui.focus === 'list';

  const nav = useListNav(runs.length, listActive, (index) => {
    const run = runs[index];
    if (run) ui.select({ runId: run.id, teamId: run.teamId });
  });

  useEffect(() => {
    if (runs.length === 0) return;
    const position = runs.findIndex((run) => run.id === ui.selection.runId);
    if (position >= 0) {
      if (position !== nav.index && !listActive) nav.setIndex(position);
    } else {
      const run = runs[Math.min(nav.index, runs.length - 1)];
      if (run) ui.select({ runId: run.id, teamId: run.teamId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, ui.selection.runId]);

  const run = runs[nav.index];

  useKeys(
    (input, key) => {
      if (input === 'r') ui.dispatch(() => startRun(ui));
      else if (input === 'p') {
        if (!run) return;
        const allowed = availableRunActions(run.status);
        if (allowed.includes('pause')) ui.dispatch(() => runAction(ui, 'pause'));
        else if (allowed.includes('resume')) ui.dispatch(() => runAction(ui, 'resume'));
        else ui.notify(`A ${RUN_STATUS_UI[run.status].label} run cannot be paused or resumed.`, 'warning');
      } else if (input === 'x') ui.dispatch(() => runAction(ui, 'cancel'));
      else if (input === 'T') ui.dispatch(() => runAction(ui, 'retry'));
      else if (input === 'm') ui.dispatch(() => messageAgent(ui));
      else if (input === 'v') ui.setRunMode(ui.runMode === 'replay' ? 'live' : 'replay');
      else if (input === 'f') {
        if (run) ui.setRunFullScreen(true);
        else ui.notify('Select a run first.', 'warning');
      } else if (input === 'y') ui.dispatch(() => copyRunTranscript(ui));
      else if (input === 'e') ui.dispatch(() => exportRunTranscript(ui));
      else if (input === 'l' || key.return) ui.setFocus('detail');
    },
    ui.lock === 'view',
  );

  const rows = Math.max(3, height - 5);
  const { slice, offset } = windowOf(runs, nav.index, rows);

  const list =
    loading && !data ? (
      <Loading label="Loading runs" />
    ) : runs.length === 0 ? (
      <EmptyState
        title="No runs yet."
        hints={['press r to start one', 'a run needs a team with at least one agent']}
      />
    ) : (
      <Box flexDirection="column">
        {slice.map((item, index) => (
          <ListRow key={item.id} selected={offset + index === nav.index} focused={listActive}>
            <RunRow run={item} />
          </ListRow>
        ))}
        <MoreRow count={runs.length - slice.length - offset} />
      </Box>
    );

  return (
    <TwoPane
      listTitle="Runs"
      listSubtitle={`${runs.length}`}
      detailTitle={ui.runMode === 'replay' ? 'Run replay' : 'Run'}
      detailSubtitle={run ? RUN_STATUS_UI[run.status].label : undefined}
      list={error ? <ErrorLine message={error} /> : list}
      detail={
        run ? (
          <RunDetail runId={run.id} height={height} columns={columns} narrow={narrow} />
        ) : (
          <EmptyState title="No run selected." hints={['press r to start a run']} />
        )
      }
      columns={columns}
      narrow={narrow}
      ratio={0.34}
    />
  );
}

function RunDetail({
  runId,
  height,
  narrow,
}: {
  runId: string;
  height: number;
  columns: number;
  narrow: boolean;
}): React.JSX.Element {
  const ui = useUi();
  const revision = ui.rev(['runs', 'events', 'messages', 'questions']);
  const { data, error, loading } = useLoader(() => ui.core.getRunDetail(runId), [runId, revision]);

  const events = data?.events ?? [];
  const [cursor, setCursor] = useState(0);
  const replay = ui.runMode === 'replay';

  // Entering replay (or switching run) starts at the latest event.
  useEffect(() => {
    setCursor(Math.max(0, events.length - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, replay]);

  useKeys(
    (_input, key) => {
      if (!replay) return;
      if (key.leftArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.rightArrow) setCursor((c) => Math.min(events.length - 1, c + 1));
    },
    ui.lock === 'view' && replay,
  );

  if (error) return <ErrorLine message={error} />;
  if (!data) return loading ? <Loading label="Loading run" /> : <EmptyState title="Nothing to show." />;

  const { run, team, agents, tasks, progress, questions } = data;
  const pendingQuestions = questions.filter((question) => question.status === 'pending');
  const settledQuestions = questions.filter((question) => question.status !== 'pending');
  const status = RUN_STATUS_UI[run.status];
  const handleOf = (agentId?: string) => agents.find((a) => a.id === agentId)?.handle;
  const titleOf = (taskId: string) => tasks.find((t) => t.id === taskId)?.title ?? taskId;

  const durationMs = runDurationMs(run);

  const timelineHeight = Math.max(3, height - 22 - Math.min(tasks.length, 8));
  const visibleEvents = replay
    ? events.slice(Math.max(0, cursor - timelineHeight + 1), cursor + 1)
    : events.slice(-timelineHeight);
  const actions = availableRunActions(run.status);

  return (
    <Box flexDirection="column">
      <Box>
        <StatusChip status={status} />
        <Text color={UI.dim}>{`  ${team.name}  ${formatRelative(run.createdAt)}`}</Text>
      </Box>
      <Text wrap="truncate-end" bold>
        {truncate(run.objective, 200)}
      </Text>
      {run.summary ? (
        <Text color={toneColor('success')} wrap="truncate-end">
          {truncate(run.summary, 200)}
        </Text>
      ) : null}
      {run.error ? (
        <Text color={toneColor('danger')} wrap="truncate-end">
          {truncate(run.error, 200)}
        </Text>
      ) : null}

      {pendingQuestions.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={toneColor('info')} wrap="truncate-end">
            {`? ${pendingQuestions.length} question(s) waiting on you — press Q to answer`}
          </Text>
          {pendingQuestions.slice(0, 3).map((question) => (
            <Box key={question.id} paddingLeft={2} flexDirection="column">
              <Text color={toneColor('info')} wrap="truncate-end">
                {question.header?.trim() ? `${truncate(question.header, 24)} — ` : ''}
                {truncate(question.question, 80)}
              </Text>
              <Dim>
                {`  ${handleOf(question.agentId) ?? question.agentId} is blocked · ${
                  question.options.length > 0
                    ? `${question.options.map((option) => option.label).join(' / ')}`
                    : 'free-text answer'
                }`}
              </Dim>
            </Box>
          ))}
          <MoreRow count={pendingQuestions.length - 3} />
        </Box>
      ) : null}

      <Box marginTop={1}>
        <ProgressLine
          percent={progress.percent}
          label={`${progress.completed}/${progress.total} tasks · ${progress.running} running · ${progress.blocked} blocked · ${progress.failed} failed`}
        />
      </Box>
      <Field
        label="totals"
        value={`${formatTokens(totalTokens(run.totals.usage))} tokens · ${formatUsd(run.totals.costUsd)} · ${formatDuration(durationMs)} · ${run.totals.agentActivations} activations · ${run.totals.toolCalls} tools · ${run.totals.messages} msgs`}
      />
      <Field label="workspace" value={run.workspace ?? team.workspace ?? '(current directory)'} />
      <Field label="actions" value={actions.length ? actions.join(' · ') : 'none (run is finished)'} />

      <SectionTitle>Agent configuration for this run</SectionTitle>
      {run.agentConfigSnapshot.length === 0 ? (
        <Dim>No snapshot recorded (the run never started).</Dim>
      ) : (
        run.agentConfigSnapshot.map((snap) => (
          <Box key={snap.agentId}>
            <Box width={14} flexShrink={0}>
              <Text>
                {snap.isOrchestrator ? <Text color={toneColor('info')}>★ </Text> : '  '}
                {snap.handle}
              </Text>
            </Box>
            <Box width={20} flexShrink={1}>
              <Text color={UI.dim} wrap="truncate-end">
                {snap.role}
              </Text>
            </Box>
            <Box width={10} flexShrink={0}>
              <Text>{shortModelLabel(snap.model)}</Text>
            </Box>
            <Text color={toneColor(EFFORT_UI[snap.effort].tone)}>
              {EFFORT_UI[snap.effort].bar} {EFFORT_UI[snap.effort].label}
            </Text>
          </Box>
        ))
      )}

      <SectionTitle>Task board</SectionTitle>
      {tasks.length === 0 ? (
        <Dim>The orchestrator has not created any tasks yet.</Dim>
      ) : (
        tasks
          .slice(0, 8)
          .map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              agentHandle={handleOf(task.assignedAgentId)}
              dependencyTitles={task.dependencies.map(titleOf)}
            />
          ))
      )}
      {tasks.length > 8 ? <MoreRow count={tasks.length - 8} /> : null}

      {settledQuestions.length > 0 ? (
        <Box flexDirection="column">
          <SectionTitle>Questions already answered</SectionTitle>
          {settledQuestions.slice(0, 4).map((question) => (
            <Box key={question.id} flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={toneColor(question.status === 'answered' ? 'success' : 'muted')}>
                  {question.status === 'answered' ? '✓ ' : '⊘ '}
                </Text>
                {question.header?.trim() ? `${truncate(question.header, 24)} — ` : ''}
                {truncate(question.question, 60)}
              </Text>
              <Box paddingLeft={2}>
                <Text wrap="truncate-end">
                  <Text color={UI.dim}>{`${question.answeredBy ?? question.status}: `}</Text>
                  {truncate(question.answer ?? '—', 70)}
                </Text>
              </Box>
            </Box>
          ))}
          <MoreRow count={settledQuestions.length - 4} />
        </Box>
      ) : null}

      <Box marginTop={narrow ? 0 : 1}>
        <Text bold color={UI.accent}>
          {replay ? `Replay  ${events.length ? cursor + 1 : 0}/${events.length}` : 'Timeline (live)'}
        </Text>
      </Box>
      {visibleEvents.length === 0 ? (
        <Dim>No events yet.</Dim>
      ) : (
        visibleEvents.map((event) => (
          <EventRow key={event.id} event={event} handle={handleOf(event.agentId)} />
        ))
      )}

      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'p', label: 'pause/resume' },
            { key: 'x', label: 'cancel' },
            { key: 'T', label: 'retry' },
            { key: 'v', label: replay ? 'live' : 'replay' },
            ...(replay ? [{ key: '←→', label: 'step' }] : []),
            { key: 'f', label: 'full screen' },
            { key: 'y', label: 'copy transcript' },
            { key: 'e', label: 'export transcript' },
            { key: 'm', label: 'message agent' },
            { key: 'r', label: 'new run' },
            ...(pendingQuestions.length > 0 ? [{ key: 'Q', label: 'answer question' }] : []),
          ]}
        />
      </Box>
    </Box>
  );
}
