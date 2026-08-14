import React from 'react';
import { Box, Text } from 'ink';
import type { RunEvent } from '@claude-team/domain';
import { eventTone, formatClock, formatDuration, formatRelative, truncate } from '@claude-team/ui-shared';
import { formatUsd, totalTokens } from '@claude-team/domain';
import { toneColor, UI } from '../theme.js';
import { useKeys, useListNav, useLoader, windowOf } from '../lib/hooks.js';
import { useUi } from '../store.js';
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
import { EventRow } from '../components/rows.js';

/** The global live feed. Reloads on events only — never on a timer. */
export function ActivityView({ height, columns, narrow }: ViewProps): React.JSX.Element {
  const ui = useUi();
  const revision = ui.rev(['events', 'messages', 'runs', 'approvals']);
  const { data, error, loading } = useLoader(() => ui.core.recentActivity(200), [revision]);

  const events: RunEvent[] = [...(data ?? [])].reverse();
  const listActive = ui.lock === 'view' && ui.focus === 'list';
  const nav = useListNav(events.length, listActive);

  useKeys(
    (input, key) => {
      if (key.return || input === 'l') ui.setFocus('detail');
      else if (input === 'o') {
        const event = events[nav.index];
        if (event) {
          ui.select({ runId: event.runId });
          ui.setSection('runs');
        }
      }
    },
    ui.lock === 'view',
  );

  const rows = Math.max(3, height - 5);
  const { slice, offset } = windowOf(events, nav.index, rows);
  const selected = events[nav.index];

  const list =
    loading && !data ? (
      <Loading label="Loading activity" />
    ) : events.length === 0 ? (
      <EmptyState
        title="Nothing has happened yet."
        hints={['start a run (4 → r) and the timeline fills in live']}
      />
    ) : (
      <Box flexDirection="column">
        {slice.map((event, index) => (
          <ListRow key={event.id} selected={offset + index === nav.index} focused={listActive}>
            <EventRow event={event} />
          </ListRow>
        ))}
        <MoreRow count={events.length - slice.length - offset} />
      </Box>
    );

  const detail = error ? (
    <ErrorLine message={error} />
  ) : !selected ? (
    <EmptyState title="Select an event to see its payload." />
  ) : (
    <EventDetail event={selected} narrow={narrow} />
  );

  return (
    <TwoPane
      listTitle="Activity"
      listSubtitle={`${events.length} events`}
      detailTitle="Event"
      detailSubtitle={selected ? formatRelative(selected.createdAt) : undefined}
      list={list}
      detail={detail}
      columns={columns}
      narrow={narrow}
      ratio={0.62}
    />
  );
}

function EventDetail({ event, narrow }: { event: RunEvent; narrow: boolean }): React.JSX.Element {
  const tone = eventTone(event.type, event.level);
  const payload = JSON.stringify(event.data ?? {}, null, 2).split('\n');
  return (
    <Box flexDirection="column">
      <Text color={toneColor(tone)} bold>
        {event.type}
      </Text>
      <Text wrap="wrap">{truncate(event.summary, 400)}</Text>
      <Field label="seq" value={`#${event.seq}`} />
      <Field label="at" value={formatClock(event.createdAt)} />
      <Field label="run" value={event.runId} />
      <Field label="agent" value={event.agentId ?? '—'} />
      <Field label="task" value={event.taskId ?? '—'} />
      <Field label="level" value={event.level} tone={tone} />
      {event.model ? <Field label="model" value={`${event.model} · ${event.effort ?? '—'}`} /> : null}
      {event.usage ? (
        <Field
          label="usage"
          value={`${totalTokens(event.usage)} tokens · ${formatUsd(event.costUsd)} · ${formatDuration(event.durationMs)}`}
        />
      ) : null}

      {narrow ? null : (
        <Box flexDirection="column">
          <SectionTitle>Payload</SectionTitle>
          {payload.length <= 1 ? (
            <Dim>—</Dim>
          ) : (
            payload.slice(0, 14).map((line, index) => (
              <Text key={`${event.id}-${index}`} color={UI.dim} wrap="truncate-end">
                {line}
              </Text>
            ))
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <KeyHints hints={[{ key: 'o', label: 'open the run' }, { key: '↑↓', label: 'browse' }]} />
      </Box>
    </Box>
  );
}
