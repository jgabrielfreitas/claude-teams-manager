import React, { useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import { formatTokens, formatUsd, isRunTerminal, shortModelLabel, totalTokens } from '@claude-team/domain';
import { EFFORT_UI, RUN_STATUS_UI, formatDuration, runDurationMs, truncate } from '@claude-team/ui-shared';
import { toneColor, UI } from '../theme.js';
import { useLoader, useTerminalSize } from '../lib/hooks.js';
import { useUi } from '../store.js';
import { ApprovalModal } from '../components/ApprovalModal.js';
import { DialogHost } from '../components/Dialogs.js';
import { Dim, ErrorLine, Field, Loading, SectionTitle, StatusChip } from '../components/ui.js';
import { EventRow, ProgressLine, TaskRow } from '../components/rows.js';

/**
 * `claude-team run "…"` — a single run, live, then exit.
 *
 * Approvals still interrupt here: a blocked agent must be answerable even when
 * the full interface is not open.
 */
export function RunLive({ runId }: { runId: string }): React.JSX.Element {
  const ui = useUi();
  const app = useApp();
  const size = useTerminalSize();
  const revision = ui.rev(['runs', 'events', 'messages']);
  const [finished, setFinished] = useState(false);

  const { data, error } = useLoader(() => ui.core.getRunDetail(runId), [runId, revision]);

  useEffect(() => {
    let cancelled = false;
    ui.core
      .waitForRun(runId)
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return;
        setFinished(true);
        // One more frame so the final timeline is visible before we leave.
        setTimeout(() => app.exit(), 250);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, ui.core, app]);

  if (error) return <ErrorLine message={error} />;
  if (!data) return <Loading label="Starting the run" />;

  const { run, team, agents, tasks, progress, events } = data;
  const status = RUN_STATUS_UI[run.status];
  const handleOf = (agentId?: string) => agents.find((agent) => agent.id === agentId)?.handle;
  const timelineHeight = Math.max(6, size.rows - 18);
  const durationMs = runDurationMs(run);

  return (
    <Box flexDirection="column" width={size.columns}>
      <Box>
        <StatusChip status={status} />
        <Text bold>{`  ${truncate(run.objective, Math.max(20, size.columns - 24))}`}</Text>
      </Box>
      <Text color={UI.dim}>
        {team.name} · {run.id}
      </Text>

      <Box marginTop={1}>
        <ProgressLine
          percent={progress.percent}
          label={`${progress.completed}/${progress.total} tasks · ${formatTokens(
            totalTokens(run.totals.usage),
          )} tokens · ${formatUsd(run.totals.costUsd)} · ${formatDuration(durationMs)}`}
        />
      </Box>

      {run.agentConfigSnapshot.length > 0 ? (
        <Text color={UI.dim} wrap="truncate-end">
          {run.agentConfigSnapshot
            .map(
              (snap) =>
                `${snap.isOrchestrator ? '★' : ''}${snap.handle} ${shortModelLabel(snap.model)}/${
                  EFFORT_UI[snap.effort].label
                }`,
            )
            .join('  ')}
        </Text>
      ) : null}

      {tasks.length > 0 ? (
        <Box flexDirection="column">
          <SectionTitle>Tasks</SectionTitle>
          {tasks.slice(0, 8).map((task) => (
            <TaskRow key={task.id} task={task} agentHandle={handleOf(task.assignedAgentId)} />
          ))}
        </Box>
      ) : null}

      <SectionTitle>Timeline</SectionTitle>
      {events.length === 0 ? (
        <Dim>Waiting for the first event…</Dim>
      ) : (
        events.slice(-timelineHeight).map((event) => (
          <EventRow key={event.id} event={event} handle={handleOf(event.agentId)} />
        ))
      )}

      {isRunTerminal(run.status) || finished ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={toneColor(status.tone)} bold>
            {status.glyph} {status.label}
          </Text>
          {run.summary ? <Text wrap="wrap">{run.summary}</Text> : null}
          {run.error ? <Text color={toneColor('danger')}>{run.error}</Text> : null}
          <Field
            label="totals"
            value={`${formatTokens(totalTokens(run.totals.usage))} tokens · ${formatUsd(
              run.totals.costUsd,
            )} · ${run.totals.agentActivations} activations · ${run.totals.toolCalls} tool calls`}
          />
        </Box>
      ) : null}

      <DialogHost />
      <ApprovalModal />
    </Box>
  );
}
