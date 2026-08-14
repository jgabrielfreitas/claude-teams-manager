import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { USER_PARTICIPANT, type Agent, type AgentMessage } from '@claude-team/domain';
import {
  AGENT_STATUS_UI,
  MESSAGE_STATUS_UI,
  MESSAGE_TYPE_UI,
  formatClock,
  truncate,
} from '@claude-team/ui-shared';
import { toneColor, UI } from '../theme.js';
import { useKeys, useListNav, useLoader, windowOf } from '../lib/hooks.js';
import { useUi } from '../store.js';
import { pickRun } from '../actions.js';
import { TwoPane, type ViewProps } from '../components/Layout.js';
import {
  Dim,
  EmptyState,
  ErrorLine,
  KeyHints,
  ListRow,
  Loading,
  MoreRow,
  SectionTitle,
} from '../components/ui.js';
import { MessageRow } from '../components/rows.js';

const ALL = '__all__';

export function MessagesView({ height, columns, narrow }: ViewProps): React.JSX.Element {
  const ui = useUi();
  const revision = ui.rev(['messages', 'runs', 'agents']);
  const runId = ui.selection.runId;

  const { data, error, loading } = useLoader(async () => {
    if (!runId) return undefined;
    const detail = await ui.core.getRunDetail(runId);
    return detail;
  }, [runId, revision]);

  const agents: Agent[] = data?.agents ?? [];
  const messages: AgentMessage[] = data?.messages ?? [];
  const listActive = ui.lock === 'view' && ui.focus === 'list';

  const entries = [{ id: ALL, label: 'All messages' }, ...agents.map((a) => ({ id: a.id, label: a.handle }))];
  const nav = useListNav(entries.length, listActive);

  useEffect(() => {
    if (!runId) void pickRunIfPossible(ui);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useKeys(
    (input, key) => {
      if (input === 'u') void pickRun(ui);
      else if (input === 'm') void composeMessage(ui, agents, nav.index === 0 ? undefined : entries[nav.index]?.id);
      else if (key.return) ui.setFocus('detail');
    },
    ui.lock === 'view',
  );

  const nameOf = (id: string): string =>
    id === USER_PARTICIPANT ? 'you' : (agents.find((a) => a.id === id)?.handle ?? id.slice(0, 8));

  const selectedEntry = entries[nav.index];
  const visible =
    !selectedEntry || selectedEntry.id === ALL
      ? messages
      : messages.filter((m) => m.from === selectedEntry.id || m.to.includes(selectedEntry.id));

  const rows = Math.max(3, height - 5);
  const { slice, offset } = windowOf(entries, nav.index, rows);

  const list = !runId ? (
    <EmptyState title="No run selected." hints={['u — pick a run', 'or open one from the Runs section']} />
  ) : (
    <Box flexDirection="column">
      {slice.map((entry, index) => {
        const agent = agents.find((a) => a.id === entry.id);
        const unread = messages.filter((m) => m.to.includes(entry.id) && m.status === 'pending').length;
        return (
          <ListRow key={entry.id} selected={offset + index === nav.index} focused={listActive}>
            <Box>
              {agent ? (
                <Text color={toneColor(AGENT_STATUS_UI[agent.status].tone)}>
                  {AGENT_STATUS_UI[agent.status].glyph}{' '}
                </Text>
              ) : (
                <Text color={UI.dim}>≡ </Text>
              )}
              <Box flexGrow={1} overflow="hidden">
                <Text wrap="truncate-end">{entry.label}</Text>
              </Box>
              {unread > 0 ? <Text color={toneColor('warning')}>{unread}</Text> : null}
            </Box>
          </ListRow>
        );
      })}
      <MoreRow count={entries.length - slice.length - offset} />
    </Box>
  );

  const conversationHeight = Math.max(4, height - 10);
  const detail = error ? (
    <ErrorLine message={error} />
  ) : !runId ? (
    <EmptyState
      title="Messages belong to a run."
      hints={['press u to pick a run', 'messages appear as agents talk to each other']}
    />
  ) : loading && !data ? (
    <Loading label="Loading conversation" />
  ) : messages.length === 0 ? (
    <EmptyState
      title="No messages in this run yet."
      hints={['press m to write to an agent yourself']}
    />
  ) : (
    <Box flexDirection="column">
      <Text color={UI.dim} wrap="truncate-end">
        {truncate(data?.run.objective ?? '', 120)}
      </Text>
      {narrow ? null : (
        <Box marginTop={1}>
          <Box width={5} flexShrink={0}>
            <Dim>#</Dim>
          </Box>
          <Box width={22} flexShrink={0}>
            <Dim>from → to</Dim>
          </Box>
          <Box width={9} flexShrink={0}>
            <Dim>type</Dim>
          </Box>
          <Box width={6} flexShrink={0}>
            <Dim>st</Dim>
          </Box>
          <Dim>content</Dim>
        </Box>
      )}
      {visible.slice(-conversationHeight).map((message) => (
        <MessageRow key={message.id} message={message} nameOf={nameOf} />
      ))}

      {visible.length > 0 ? (
        <Box flexDirection="column">
          <SectionTitle>Latest</SectionTitle>
          <Latest message={visible[visible.length - 1]} nameOf={nameOf} />
        </Box>
      ) : (
        <Dim>No messages for this participant.</Dim>
      )}

      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'm', label: 'write to an agent' },
            { key: 'u', label: 'change run' },
            { key: 'tab', label: 'panel' },
          ]}
        />
      </Box>
    </Box>
  );

  return (
    <TwoPane
      listTitle="Participants"
      listSubtitle={runId ? `${messages.length} msgs` : undefined}
      detailTitle={selectedEntry?.id === ALL ? 'Conversation' : `Inbox · ${selectedEntry?.label ?? ''}`}
      detailSubtitle={data?.team.name}
      list={list}
      detail={detail}
      columns={columns}
      narrow={narrow}
      ratio={0.28}
    />
  );
}

function Latest({
  message,
  nameOf,
}: {
  message: AgentMessage;
  nameOf: (id: string) => string;
}): React.JSX.Element {
  const type = MESSAGE_TYPE_UI[message.type];
  const status = MESSAGE_STATUS_UI[message.status];
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={UI.dim}>{formatClock(message.createdAt)} </Text>
        <Text bold>{nameOf(message.from)}</Text>
        <Text color={toneColor(type.tone)}> {type.glyph} </Text>
        <Text bold>{message.to.map(nameOf).join(', ')}</Text>
        <Text color={toneColor(status.tone)}>{`  ${status.label}`}</Text>
      </Text>
      {message.content
        .split('\n')
        .slice(0, 6)
        .map((line, index) => (
          <Text key={`${message.id}-${index}`} wrap="truncate-end">
            {'  '}
            {line}
          </Text>
        ))}
    </Box>
  );
}

async function pickRunIfPossible(ui: ReturnType<typeof useUi>): Promise<void> {
  const runs = await ui.core.listRuns({ limit: 1 });
  if (runs[0]) ui.select({ runId: runs[0].id, teamId: runs[0].teamId });
}

async function composeMessage(
  ui: ReturnType<typeof useUi>,
  agents: Agent[],
  presetAgentId?: string,
): Promise<void> {
  const runId = ui.selection.runId;
  if (!runId) {
    ui.notify('Pick a run first (u).', 'warning');
    return;
  }
  let agentId = presetAgentId;
  if (!agentId) {
    agentId = await ui.dialogs.select({
      title: 'Send to',
      items: agents.map((agent) => ({ value: agent.id, label: agent.handle, hint: agent.role })),
    });
  }
  if (!agentId) return;
  const recipient = agentId;
  const type = await ui.dialogs.select({
    title: 'Message type',
    items: Object.entries(MESSAGE_TYPE_UI).map(([value, ui2]) => ({
      value,
      label: `${ui2.glyph} ${ui2.label}`,
      tone: ui2.tone,
    })),
  });
  if (!type) return;
  const content = await ui.dialogs.text({
    title: 'Your message',
    label: 'you',
    placeholder: 'Type what the agent should know or do…',
  });
  if (!content?.trim()) return;
  await ui.guard(
    () =>
      ui.core.sendAgentMessage({
        runId,
        from: USER_PARTICIPANT,
        to: [recipient],
        type,
        content,
      }),
    'Message delivered.',
  );
}
