import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { shortModelLabel, type Agent } from '@claude-team/domain';
import {
  AGENT_STATUS_UI,
  EFFORT_UI,
  MESSAGE_TYPE_UI,
  TASK_STATUS_UI,
  formatDuration,
  formatRelative,
  truncate,
} from '@claude-team/ui-shared';
import { toneColor, UI } from '../theme.js';
import { useKeys, useListNav, useLoader, windowOf } from '../lib/hooks.js';
import { useUi } from '../store.js';
import {
  changeAgentEffort,
  createAgent,
  deleteAgent,
  duplicateAgent,
  editAgent,
  editAgentCommunication,
  editAgentPermissions,
  messageAgent,
  switchAgentModel,
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
import { AgentListRow, CapabilityChips, EventRow } from '../components/rows.js';

interface Entry {
  agent: Agent;
  teamName: string;
}

export function AgentsView({ height, columns, narrow }: ViewProps): React.JSX.Element {
  const ui = useUi();
  const revision = ui.rev(['agents', 'teams']);
  const { data, error, loading } = useLoader(async () => {
    const teams = await ui.core.listTeams();
    const entries: Entry[] = [];
    for (const team of teams) {
      for (const agent of team.agents) entries.push({ agent, teamName: team.name });
    }
    return entries;
  }, [revision]);

  const entries = data ?? [];
  const listActive = ui.lock === 'view' && ui.focus === 'list';

  const nav = useListNav(entries.length, listActive, (index) => {
    const entry = entries[index];
    if (entry) ui.select({ agentId: entry.agent.id, teamId: entry.agent.teamId });
  });

  useEffect(() => {
    if (entries.length === 0) return;
    const position = entries.findIndex((entry) => entry.agent.id === ui.selection.agentId);
    if (position >= 0) {
      if (position !== nav.index && !listActive) nav.setIndex(position);
    } else {
      const entry = entries[Math.min(nav.index, entries.length - 1)];
      if (entry) ui.select({ agentId: entry.agent.id, teamId: entry.agent.teamId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, ui.selection.agentId]);

  useKeys(
    (input, key) => {
      if (input === 'c') void createAgent(ui);
      else if (input === 'e') void editAgent(ui);
      else if (input === 'M') void switchAgentModel(ui);
      else if (input === 'E') void changeAgentEffort(ui);
      else if (input === 'P') void editAgentPermissions(ui);
      else if (input === 'w') void editAgentCommunication(ui);
      else if (input === 'y') void duplicateAgent(ui);
      else if (input === 'd') void deleteAgent(ui);
      else if (input === 'm') void messageAgent(ui);
      else if (input === 'i' || key.return) ui.setFocus('detail');
    },
    ui.lock === 'view',
  );

  const rows = Math.max(3, height - 5);
  const { slice, offset } = windowOf(entries, nav.index, rows);

  const list =
    loading && !data ? (
      <Loading label="Loading agents" />
    ) : entries.length === 0 ? (
      <EmptyState
        title="No agents yet."
        hints={['create a team first (2 → c)', 'then press c here to add an agent']}
      />
    ) : (
      <Box flexDirection="column">
        {slice.map((entry, index) => (
          <ListRow
            key={entry.agent.id}
            selected={offset + index === nav.index}
            focused={listActive}
          >
            <AgentListRow agent={entry.agent} teamName={entry.teamName} />
          </ListRow>
        ))}
        <MoreRow count={entries.length - slice.length - offset} />
      </Box>
    );

  const agentId = entries[nav.index]?.agent.id ?? ui.selection.agentId;

  return (
    <TwoPane
      listTitle="Agents"
      listSubtitle={`${entries.length}`}
      detailTitle="Agent inspector"
      detailSubtitle={entries[nav.index]?.teamName}
      list={error ? <ErrorLine message={error} /> : list}
      detail={
        agentId ? (
          <Inspector agentId={agentId} height={height} columns={columns} narrow={narrow} />
        ) : (
          <EmptyState title="No agent selected." />
        )
      }
      columns={columns}
      narrow={narrow}
    />
  );
}

function Inspector({
  agentId,
  height,
  narrow,
}: {
  agentId: string;
  height: number;
  columns: number;
  narrow: boolean;
}): React.JSX.Element {
  const ui = useUi();
  const revision = ui.rev(['agents', 'events', 'messages', 'runs']);
  const { data, error, loading } = useLoader(
    () => ui.core.inspectAgent(agentId, ui.selection.runId),
    [agentId, revision, ui.selection.runId],
  );

  if (error) return <ErrorLine message={error} />;
  if (!data) return loading ? <Loading label="Inspecting" /> : <EmptyState title="Nothing to show." />;

  const { agent } = data;
  const status = AGENT_STATUS_UI[agent.status];
  const effort = EFFORT_UI[agent.effort];
  const eventLines = Math.max(2, Math.floor((height - 24) / 2));

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{agent.handle}</Text>
        <Text color={UI.dim}>{`  ${agent.name} · ${agent.role}  `}</Text>
        <StatusChip status={status} />
      </Box>
      <Field label="model" value={`${shortModelLabel(agent.model)}  (${agent.model})`} />
      <Field
        label="effort"
        value={`${effort.bar} ${effort.label}`}
        tone={effort.tone}
      />
      <Field label="team" value={data.team.name} />
      <Field
        label="current task"
        value={
          data.currentTask
            ? `${TASK_STATUS_UI[data.currentTask.status].glyph} ${truncate(data.currentTask.title, 50)}`
            : 'idle'
        }
      />
      <Field
        label="activity"
        value={`${data.activations} activations · ${data.toolCalls} tool calls · ${formatDuration(data.runtimeMs)}`}
      />
      <Field
        label="messages"
        value={`${data.messageCount} total · ${data.unreadCount} unread`}
        tone={data.unreadCount > 0 ? 'warning' : undefined}
      />
      <Field label="can message" value={data.reachable.length ? data.reachable.join(', ') : 'nobody'} />
      <Field label="updated" value={formatRelative(agent.updatedAt)} />

      <SectionTitle>Capabilities</SectionTitle>
      <CapabilityChips tools={agent.tools} groups={ui.core.listToolGroups()} />

      {narrow ? null : (
        <Box flexDirection="column">
          <SectionTitle>Inbox</SectionTitle>
          {data.inbox.length === 0 ? (
            <Dim>Empty.</Dim>
          ) : (
            data.inbox.slice(-eventLines).map((message) => (
              <Text key={message.id} wrap="truncate-end">
                <Text color={toneColor(MESSAGE_TYPE_UI[message.type].tone)}>
                  {MESSAGE_TYPE_UI[message.type].glyph}{' '}
                </Text>
                <Text color={UI.dim}>#{message.seq} </Text>
                {truncate(message.content, 90)}
              </Text>
            ))
          )}
        </Box>
      )}

      <SectionTitle>Recent events</SectionTitle>
      {data.lastEvents.length === 0 ? (
        <Dim>No events for this agent in the latest run.</Dim>
      ) : (
        data.lastEvents.slice(-eventLines).map((event) => <EventRow key={event.id} event={event} />)
      )}

      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'e', label: 'edit' },
            { key: 'M', label: 'model' },
            { key: 'E', label: 'effort' },
            { key: 'P', label: 'permissions' },
            { key: 'w', label: 'can message' },
            { key: 'm', label: 'send message' },
            { key: 'y', label: 'duplicate' },
            { key: 'd', label: 'delete' },
          ]}
        />
      </Box>
    </Box>
  );
}
