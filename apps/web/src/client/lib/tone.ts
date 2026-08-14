import {
  AGENT_STATUS_UI,
  EFFORT_UI,
  MESSAGE_STATUS_UI,
  MESSAGE_TYPE_UI,
  RUN_STATUS_UI,
  TASK_STATUS_UI,
  type StatusDescriptor,
  type Tone,
} from '@claude-team/ui-shared';
import type {
  AgentEffort,
  AgentMessageStatus,
  AgentMessageType,
  AgentStatus,
  RunStatus,
  TaskStatus,
} from '@claude-team/domain';

/**
 * The one and only place where the shared `Tone` vocabulary becomes CSS.
 *
 * Components never name a colour: they set a tone class, and the stylesheet
 * resolves `--tone` from it. Changing "blocked is amber" happens in
 * `@claude-team/ui-shared`, and both this app and the TUI follow.
 */
export function toneClass(tone: Tone | undefined): string {
  return `tone-${tone ?? 'neutral'}`;
}

export const agentStatusUi = (status: AgentStatus): StatusDescriptor => AGENT_STATUS_UI[status];
export const runStatusUi = (status: RunStatus): StatusDescriptor => RUN_STATUS_UI[status];
export const taskStatusUi = (status: TaskStatus): StatusDescriptor => TASK_STATUS_UI[status];
export const messageStatusUi = (status: AgentMessageStatus): StatusDescriptor =>
  MESSAGE_STATUS_UI[status];
export const messageTypeUi = (type: AgentMessageType) => MESSAGE_TYPE_UI[type];
export const effortUi = (effort: AgentEffort) => EFFORT_UI[effort];

export type { Tone, StatusDescriptor };
