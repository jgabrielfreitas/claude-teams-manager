import React from 'react';
import { Box, Text } from 'ink';
import {
  permissionMode,
  shortModelLabel,
  type Agent,
  type AgentMessage,
  type Run,
  type RunEvent,
  type Task,
  type ToolGroupDescriptor,
  type ToolPermission,
} from '@claude-team/domain';
import {
  AGENT_STATUS_UI,
  EFFORT_UI,
  MESSAGE_STATUS_UI,
  MESSAGE_TYPE_UI,
  RUN_STATUS_UI,
  TASK_STATUS_UI,
  eventTone,
  formatClock,
  formatDuration,
  formatRelative,
  progressBar,
  truncate,
  type Tone,
} from '@claude-team/ui-shared';
import { toneColor, UI } from '../theme.js';

/** `● handle  role  Model  Effort  status` — the canonical agent line. */
export function AgentRow({ agent, teamLabel }: { agent: Agent; teamLabel?: string }): React.JSX.Element {
  const status = AGENT_STATUS_UI[agent.status];
  const effort = EFFORT_UI[agent.effort];
  return (
    <Box>
      <Text color={toneColor(status.tone)}>{status.glyph} </Text>
      <Box width={14} flexShrink={0}>
        <Text bold wrap="truncate-end">
          {agent.handle}
        </Text>
      </Box>
      <Box width={20} flexShrink={1} overflow="hidden">
        <Text color={UI.dim} wrap="truncate-end">
          {teamLabel ? `${teamLabel} · ` : ''}
          {agent.role}
        </Text>
      </Box>
      <Box width={9} flexShrink={0}>
        <Text wrap="truncate-end">{shortModelLabel(agent.model)}</Text>
      </Box>
      <Box width={9} flexShrink={0}>
        <Text color={toneColor(effort.tone)} wrap="truncate-end">
          {effort.bar} {effort.label}
        </Text>
      </Box>
      <Text color={toneColor(status.tone)} wrap="truncate-end">
        {status.label}
      </Text>
    </Box>
  );
}

/** Compact agent line for narrow list panes. */
export function AgentListRow({ agent, teamName }: { agent: Agent; teamName?: string }): React.JSX.Element {
  const status = AGENT_STATUS_UI[agent.status];
  return (
    <Box>
      <Text color={toneColor(status.tone)}>{status.glyph} </Text>
      <Box width={14} flexShrink={0}>
        <Text wrap="truncate-end">{agent.handle}</Text>
      </Box>
      <Box flexGrow={1} overflow="hidden">
        <Text color={UI.dim} wrap="truncate-end">
          {teamName ?? ''}
        </Text>
      </Box>
      <Box width={7} flexShrink={0} justifyContent="flex-end">
        <Text color={UI.dim} wrap="truncate-end">
          {shortModelLabel(agent.model)}
        </Text>
      </Box>
    </Box>
  );
}

/** Capability grants, laid out as a wrapping grid of `group  mode` chips. */
export function CapabilityChips({
  tools,
  groups,
  width = 24,
}: {
  tools: ToolPermission[];
  groups: ToolGroupDescriptor[];
  width?: number;
}): React.JSX.Element {
  return (
    <Box flexWrap="wrap">
      {groups.map((group) => {
        const mode = permissionMode(tools, group.id);
        const tone: Tone = mode === 'allow' ? 'success' : mode === 'ask' ? 'warning' : 'muted';
        return (
          <Box key={group.id} width={width} flexShrink={0}>
            <Text color={toneColor(tone)} wrap="truncate-end">
              {mode === 'allow' ? '✓' : mode === 'ask' ? '?' : '✗'} {mode.padEnd(6)}
              <Text color={UI.dim}>{truncate(group.label, Math.max(6, width - 10))}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function RunRow({ run, showTeam }: { run: Run; showTeam?: string }): React.JSX.Element {
  const status = RUN_STATUS_UI[run.status];
  return (
    <Box>
      <Text color={toneColor(status.tone)}>{status.glyph} </Text>
      <Box flexGrow={1} overflow="hidden">
        <Text wrap="truncate-end">{truncate(run.objective, 60)}</Text>
      </Box>
      <Text color={UI.dim} wrap="truncate-end">
        {' '}
        {showTeam ? `${truncate(showTeam, 12)} · ` : ''}
        {formatRelative(run.createdAt)}
      </Text>
    </Box>
  );
}

export function TaskRow({
  task,
  agentHandle,
  dependencyTitles,
}: {
  task: Task;
  agentHandle?: string;
  dependencyTitles?: string[];
}): React.JSX.Element {
  const status = TASK_STATUS_UI[task.status];
  return (
    <Box>
      <Text color={toneColor(status.tone)}>{status.glyph} </Text>
      <Box width={10} flexShrink={0}>
        <Text color={toneColor(status.tone)} wrap="truncate-end">
          {status.label}
        </Text>
      </Box>
      <Box flexGrow={1} overflow="hidden">
        <Text wrap="truncate-end">
          {truncate(task.title, 48)}
          {agentHandle ? <Text color={UI.dim}>{`  @${agentHandle}`}</Text> : null}
          {dependencyTitles && dependencyTitles.length > 0 ? (
            <Text color={UI.dim}>{`  ⟵ ${dependencyTitles.map((t) => truncate(t, 18)).join(', ')}`}</Text>
          ) : null}
          {task.attempts > 1 ? <Text color={toneColor('warning')}>{`  ×${task.attempts}`}</Text> : null}
        </Text>
      </Box>
    </Box>
  );
}

export function EventRow({ event, handle }: { event: RunEvent; handle?: string }): React.JSX.Element {
  const tone = eventTone(event.type, event.level);
  return (
    <Box>
      <Box width={9} flexShrink={0}>
        <Text color={UI.dim}>{formatClock(event.createdAt)}</Text>
      </Box>
      <Box width={11} flexShrink={0}>
        <Text color={toneColor(tone)} wrap="truncate-end">
          {handle ?? event.type.replace(/_/g, ' ').slice(0, 10)}
        </Text>
      </Box>
      <Box flexGrow={1} overflow="hidden">
        <Text wrap="truncate-end" color={tone === 'neutral' ? undefined : toneColor(tone)}>
          {truncate(event.summary, 200)}
        </Text>
      </Box>
      {event.durationMs !== undefined ? (
        <Text color={UI.dim} wrap="truncate-end">
          {' '}
          {formatDuration(event.durationMs)}
        </Text>
      ) : null}
    </Box>
  );
}

export function MessageRow({
  message,
  nameOf,
}: {
  message: AgentMessage;
  nameOf: (id: string) => string;
}): React.JSX.Element {
  const type = MESSAGE_TYPE_UI[message.type];
  const status = MESSAGE_STATUS_UI[message.status];
  return (
    <Box>
      <Box width={5} flexShrink={0}>
        <Text color={UI.dim}>#{message.seq}</Text>
      </Box>
      <Box width={22} flexShrink={0}>
        <Text wrap="truncate-end">
          {nameOf(message.from)}
          <Text color={toneColor(type.tone)}> {type.glyph} </Text>
          {message.to.map(nameOf).join(',')}
        </Text>
      </Box>
      <Box width={9} flexShrink={0}>
        <Text color={toneColor(type.tone)} wrap="truncate-end">
          {type.label}
        </Text>
      </Box>
      <Box width={6} flexShrink={0}>
        <Text color={toneColor(status.tone)} wrap="truncate-end">
          {status.glyph}
        </Text>
      </Box>
      <Box flexGrow={1} overflow="hidden">
        <Text wrap="truncate-end">{truncate(message.content, 200)}</Text>
      </Box>
    </Box>
  );
}

export function ProgressLine({
  percent,
  width = 18,
  label,
}: {
  percent: number;
  width?: number;
  label?: string;
}): React.JSX.Element {
  return (
    <Text>
      <Text color={toneColor(percent >= 100 ? 'success' : 'active')}>{progressBar(percent, width)}</Text>
      <Text color={UI.dim}>{` ${String(percent).padStart(3)}%${label ? ` ${label}` : ''}`}</Text>
    </Text>
  );
}
