import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import type { TeamWithAgents } from '@claude-team/domain';
import { formatRelative, truncate } from '@claude-team/ui-shared';
import { toneColor, UI } from '../theme.js';
import { useKeys, useListNav, useLoader, windowOf } from '../lib/hooks.js';
import { useUi } from '../store.js';
import {
  createAgent,
  createTeam,
  deleteTeam,
  duplicateTeam,
  editTeam,
  exportTeam,
  importTeam,
  setOrchestrator,
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
} from '../components/ui.js';
import { AgentRow } from '../components/rows.js';

export function TeamsView({ height, columns, narrow }: ViewProps): React.JSX.Element {
  const ui = useUi();
  const revision = ui.rev(['teams', 'agents', 'runs']);
  const { data, error, loading } = useLoader(() => ui.core.listTeams(), [revision]);
  const teams: TeamWithAgents[] = data ?? [];

  const listActive = ui.lock === 'view' && ui.focus === 'list';
  const detailActive = ui.lock === 'view' && ui.focus === 'detail';

  const selectedIndex = Math.max(
    0,
    teams.findIndex((team) => team.id === ui.selection.teamId),
  );
  const nav = useListNav(teams.length, listActive, (index) => {
    const team = teams[index];
    if (team) ui.select({ teamId: team.id });
  });

  useEffect(() => {
    if (teams.length === 0) return;
    const known = teams.some((team) => team.id === ui.selection.teamId);
    if (!known) {
      ui.select({ teamId: teams[Math.min(nav.index, teams.length - 1)]?.id });
    } else if (nav.index !== selectedIndex && !listActive) {
      nav.setIndex(selectedIndex);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams, selectedIndex]);

  const team = teams[nav.index];
  const roster = team?.agents ?? [];
  const rosterNav = useListNav(roster.length, detailActive, (index) => {
    const agent = roster[index];
    if (agent) ui.select({ agentId: agent.id });
  });

  useKeys(
    (input, key) => {
      if (input === 'c') void createTeam(ui);
      else if (input === 'e') void editTeam(ui);
      else if (input === 'd') void deleteTeam(ui);
      else if (input === 'r') void startRun(ui);
      else if (input === 'a') void createAgent(ui);
      else if (input === 'o') void setOrchestrator(ui);
      else if (input === 'y') void duplicateTeam(ui);
      else if (input === 'x') void exportTeam(ui);
      else if (input === 'I') void importTeam(ui);
      else if (key.return) {
        if (ui.focus === 'list') ui.setFocus('detail');
        else {
          const agent = roster[rosterNav.index];
          if (agent) {
            ui.select({ agentId: agent.id, teamId: agent.teamId });
            ui.setSection('agents');
          }
        }
      }
    },
    ui.lock === 'view',
  );

  const rows = Math.max(3, height - 5);
  const { slice, offset } = windowOf(teams, nav.index, rows);

  const list =
    loading && !data ? (
      <Loading label="Loading teams" />
    ) : teams.length === 0 ? (
      <EmptyState
        title="No teams yet."
        hints={['c — create from a preset, blank, or YAML', 'I — import a team file']}
      />
    ) : (
      <Box flexDirection="column">
        {slice.map((item, index) => {
          const selected = offset + index === nav.index;
          return (
            <ListRow key={item.id} selected={selected} focused={listActive}>
              <Box>
                <Box flexGrow={1} overflow="hidden">
                  <Text wrap="truncate-end" bold={selected}>
                    {truncate(item.name, 24)}
                  </Text>
                </Box>
                <Dim>{`${item.agents.length}`}</Dim>
              </Box>
            </ListRow>
          );
        })}
        <MoreRow count={teams.length - slice.length - offset} />
      </Box>
    );

  const detail = error ? (
    <ErrorLine message={error} />
  ) : !team ? (
    <EmptyState title="Select a team on the left, or press c to create one." />
  ) : (
    <Box flexDirection="column">
      <Field label="name" value={team.name} />
      <Field label="description" value={team.description ?? '—'} />
      <Field label="workspace" value={team.workspace ?? '(current directory)'} />
      <Field
        label="orchestrator"
        value={team.agents.find((a) => a.id === team.orchestratorId)?.handle ?? '—'}
      />
      <Field label="preset" value={team.presetId ?? 'custom'} />
      <Field
        label="budget"
        value={
          team.budget
            ? [
                team.budget.maxCostUsd !== undefined ? `$${team.budget.maxCostUsd}` : undefined,
                team.budget.maxTokens !== undefined ? `${team.budget.maxTokens} tok` : undefined,
                team.budget.maxDurationMinutes !== undefined
                  ? `${team.budget.maxDurationMinutes}min`
                  : undefined,
              ]
                .filter(Boolean)
                .join(' · ')
            : 'inherits settings'
        }
      />
      <Field label="updated" value={formatRelative(team.updatedAt)} />

      <SectionTitle>Roster</SectionTitle>
      {roster.length === 0 ? (
        <EmptyState title="This team has no agents." hints={['a — add one from a template or blank']} />
      ) : (
        roster.map((agent, index) => (
          <ListRow
            key={agent.id}
            selected={detailActive && index === rosterNav.index}
            focused={detailActive}
          >
            <Box>
              <AgentRow agent={agent} />
              {agent.id === team.orchestratorId ? (
                <Text color={toneColor('info')}> ★</Text>
              ) : null}
            </Box>
          </ListRow>
        ))
      )}

      {narrow ? null : (
        <Box marginTop={1} flexDirection="column">
          <Text color={UI.dim}>
            canMessage: {roster.map((a) => `${a.handle}→${a.canMessage.join('/')}`).join('  ') || '—'}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'c', label: 'create' },
            { key: 'e', label: 'edit' },
            { key: 'a', label: 'add agent' },
            { key: 'o', label: 'orchestrator' },
            { key: 'y', label: 'duplicate' },
            { key: 'x', label: 'export' },
            { key: 'I', label: 'import' },
            { key: 'r', label: 'run' },
            { key: 'd', label: 'delete' },
          ]}
        />
      </Box>
    </Box>
  );

  return (
    <TwoPane
      listTitle="Teams"
      listSubtitle={`${teams.length}`}
      detailTitle={team ? team.name : 'Team'}
      detailSubtitle={team ? `${team.agents.length} agents` : undefined}
      list={list}
      detail={detail}
      columns={columns}
      narrow={narrow}
    />
  );
}
