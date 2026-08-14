import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { formatTokens, formatUsd } from '@claude-team/domain';
import { AGENT_STATUS_UI, RUN_STATUS_UI, formatRelative, truncate } from '@claude-team/ui-shared';
import { toneColor, UI } from '../theme.js';
import { useKeys, useListNav, useLoader, windowOf } from '../lib/hooks.js';
import { useUi } from '../store.js';
import { createTeam, startRun } from '../actions.js';
import { TwoPane, type ViewProps } from '../components/Layout.js';
import { Dim, EmptyState, ErrorLine, KeyHints, ListRow, Loading, MoreRow, SectionTitle } from '../components/ui.js';
import { EventRow, ProgressLine } from '../components/rows.js';

export function DashboardView({ height, columns, narrow }: ViewProps): React.JSX.Element {
  const ui = useUi();
  const revision = ui.rev(['teams', 'agents', 'runs', 'events', 'approvals', 'settings']);

  // One call: the core returns per-run progress with the dashboard.
  const { data: dashboard, error, loading } = useLoader(() => ui.core.getDashboard(), [revision]);

  const teams = dashboard?.teams ?? [];
  const listActive = ui.lock === 'view' && ui.focus === 'list';
  const nav = useListNav(teams.length, listActive, (index) => {
    const team = teams[index];
    if (team) ui.select({ teamId: team.id });
  });

  useEffect(() => {
    const team = teams[nav.index];
    if (team && ui.selection.teamId !== team.id) ui.select({ teamId: team.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams.length, nav.index]);

  useKeys(
    (input, key) => {
      if (key.return) ui.setSection('teams');
      else if (input === 'c') ui.dispatch(() => createTeam(ui));
      else if (input === 'r') ui.dispatch(() => startRun(ui));
    },
    ui.lock === 'view',
  );

  const rows = Math.max(3, height - 5);
  const { slice, offset } = windowOf(teams, nav.index, rows);

  const list = loading && !dashboard ? (
    <Loading label="Loading dashboard" />
  ) : teams.length === 0 ? (
    <EmptyState
      title="No teams yet."
      hints={['press c to create one (blank, preset or YAML import)', 'press ? for help']}
    />
  ) : (
    <Box flexDirection="column">
      {slice.map((team, index) => {
        const selected = offset + index === nav.index;
        return (
          <ListRow key={team.id} selected={selected} focused={listActive}>
            <Box flexDirection="column">
              <Box>
                <Box flexGrow={1} overflow="hidden">
                  <Text wrap="truncate-end" bold={selected}>
                    {truncate(team.name, 26)}
                  </Text>
                </Box>
                {team.activeRunId ? (
                  <Text color={toneColor('active')}>▶ live</Text>
                ) : (
                  <Dim>{team.agents.length} agents</Dim>
                )}
              </Box>
              <Box>
                <Text>
                  {team.agents.slice(0, 12).map((agent) => {
                    const status = AGENT_STATUS_UI[agent.status];
                    return (
                      <Text key={agent.id} color={toneColor(status.tone)}>
                        {status.glyph}
                      </Text>
                    );
                  })}
                  <Dim>{`  ${truncate(team.description ?? team.workspace ?? '', 24)}`}</Dim>
                </Text>
              </Box>
            </Box>
          </ListRow>
        );
      })}
      <MoreRow count={teams.length - slice.length - offset} />
    </Box>
  );

  const detail = error ? (
    <ErrorLine message={error} />
  ) : !dashboard ? (
    <Loading />
  ) : (
    <Box flexDirection="column">
      <Box>
        <Text>
          <Text color={UI.dim}>teams </Text>
          {dashboard.counts.teams}
          <Text color={UI.dim}>{'   agents '}</Text>
          {dashboard.counts.agents}
          <Text color={UI.dim}>{'   busy '}</Text>
          <Text color={toneColor(dashboard.counts.runningAgents > 0 ? 'active' : 'muted')}>
            {dashboard.counts.runningAgents}
          </Text>
          <Text color={UI.dim}>{'   runs '}</Text>
          {dashboard.counts.runs}
        </Text>
      </Box>

      {dashboard.pendingApprovals.length > 0 ? (
        <Box flexDirection="column">
          <SectionTitle>Waiting for you</SectionTitle>
          {dashboard.pendingApprovals.slice(0, 3).map((approval) => (
            <Text key={approval.id} color={toneColor('warning')} wrap="truncate-end">
              ⚠ {truncate(approval.summary, 70)}
            </Text>
          ))}
        </Box>
      ) : null}

      <SectionTitle>Active runs</SectionTitle>
      {dashboard.activeRuns.length === 0 ? (
        <Dim>Nothing running. Select a team and press r to start a run.</Dim>
      ) : (
        dashboard.activeRuns.slice(0, 4).map((run) => {
          const progress = dashboard.progress[run.id];
          const status = RUN_STATUS_UI[run.status];
          return (
            <Box key={run.id} flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={toneColor(status.tone)}>{status.glyph} </Text>
                {truncate(run.objective, Math.max(20, columns - 40))}
              </Text>
              <Box paddingLeft={2}>
                <ProgressLine
                  percent={progress?.percent ?? 0}
                  label={
                    progress
                      ? `${progress.completed}/${progress.total} tasks · ${formatTokens(
                          run.totals.usage.inputTokens + run.totals.usage.outputTokens,
                        )} tok · ${formatUsd(run.totals.costUsd)}`
                      : undefined
                  }
                />
              </Box>
            </Box>
          );
        })
      )}

      <SectionTitle>Recent runs</SectionTitle>
      {dashboard.recentRuns.length === 0 ? (
        <Dim>No runs yet.</Dim>
      ) : (
        dashboard.recentRuns.slice(0, 4).map((run) => {
          const status = RUN_STATUS_UI[run.status];
          return (
            <Text key={run.id} wrap="truncate-end">
              <Text color={toneColor(status.tone)}>{status.glyph} </Text>
              {truncate(run.objective, Math.max(18, columns - 46))}
              <Text color={UI.dim}>{`  ${formatRelative(run.createdAt)}`}</Text>
            </Text>
          );
        })
      )}

      {narrow ? null : (
        <Box flexDirection="column">
          <SectionTitle>Activity</SectionTitle>
          {dashboard.recentEvents.length === 0 ? (
            <Dim>Nothing has happened yet.</Dim>
          ) : (
            dashboard.recentEvents
              .slice(-Math.max(3, height - 22))
              .reverse()
              .map((event) => <EventRow key={event.id} event={event} />)
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'c', label: 'new team' },
            { key: 'r', label: 'run' },
            { key: '↵', label: 'open team' },
          ]}
        />
      </Box>
    </Box>
  );

  return (
    <TwoPane
      listTitle="Teams"
      listSubtitle={`${teams.length}`}
      detailTitle="Dashboard"
      detailSubtitle={ui.providerId}
      list={list}
      detail={detail}
      columns={columns}
      narrow={narrow}
    />
  );
}
