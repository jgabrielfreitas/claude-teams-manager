import type {
  AgentEffort,
  AgentMessageStatus,
  AgentMessageType,
  AgentStatus,
  RunEventType,
  RunStatus,
  TaskStatus,
} from '@claude-team/domain';

/**
 * Presentation vocabulary shared by the TUI and the Web UI.
 *
 * "Running is green, blocked is amber, failed is red" is a product decision,
 * not a rendering detail, so it lives once here. Each surface maps a `Tone`
 * to its own primitive (an ANSI colour in Ink, a CSS custom property on the
 * web) and nothing else about status presentation is duplicated.
 */

export type Tone = 'neutral' | 'muted' | 'info' | 'active' | 'success' | 'warning' | 'danger';

export interface StatusDescriptor {
  label: string;
  tone: Tone;
  /** Single character for very dense rows. */
  glyph: string;
  /** True while the entity is doing something — surfaces may animate it. */
  busy?: boolean;
}

export const AGENT_STATUS_UI: Record<AgentStatus, StatusDescriptor> = {
  idle: { label: 'idle', tone: 'muted', glyph: '○' },
  queued: { label: 'queued', tone: 'info', glyph: '◔' },
  thinking: { label: 'thinking', tone: 'active', glyph: '◍', busy: true },
  working: { label: 'working', tone: 'active', glyph: '●', busy: true },
  waiting: { label: 'waiting', tone: 'warning', glyph: '◐' },
  blocked: { label: 'blocked', tone: 'warning', glyph: '◑' },
  paused: { label: 'paused', tone: 'warning', glyph: '‖' },
  failed: { label: 'failed', tone: 'danger', glyph: '✗' },
  completed: { label: 'done', tone: 'success', glyph: '✓' },
};

export const RUN_STATUS_UI: Record<RunStatus, StatusDescriptor> = {
  queued: { label: 'queued', tone: 'info', glyph: '◔' },
  running: { label: 'running', tone: 'active', glyph: '▶', busy: true },
  paused: { label: 'paused', tone: 'warning', glyph: '‖' },
  completed: { label: 'completed', tone: 'success', glyph: '✓' },
  failed: { label: 'failed', tone: 'danger', glyph: '✗' },
  cancelled: { label: 'cancelled', tone: 'muted', glyph: '⊘' },
};

export const TASK_STATUS_UI: Record<TaskStatus, StatusDescriptor> = {
  pending: { label: 'pending', tone: 'muted', glyph: '·' },
  ready: { label: 'ready', tone: 'info', glyph: '◔' },
  running: { label: 'running', tone: 'active', glyph: '▶', busy: true },
  blocked: { label: 'blocked', tone: 'warning', glyph: '⊘' },
  review: { label: 'in review', tone: 'warning', glyph: '⧗', busy: true },
  completed: { label: 'completed', tone: 'success', glyph: '✓' },
  failed: { label: 'failed', tone: 'danger', glyph: '✗' },
  cancelled: { label: 'cancelled', tone: 'muted', glyph: '⊘' },
};

export const MESSAGE_STATUS_UI: Record<AgentMessageStatus, StatusDescriptor> = {
  pending: { label: 'pending', tone: 'info', glyph: '◔' },
  read: { label: 'read', tone: 'muted', glyph: '◉' },
  processing: { label: 'processing', tone: 'active', glyph: '◍', busy: true },
  completed: { label: 'completed', tone: 'success', glyph: '✓' },
  failed: { label: 'failed', tone: 'danger', glyph: '✗' },
};

export const MESSAGE_TYPE_UI: Record<AgentMessageType, { label: string; tone: Tone; glyph: string }> = {
  message: { label: 'message', tone: 'neutral', glyph: '→' },
  question: { label: 'question', tone: 'warning', glyph: '?' },
  answer: { label: 'answer', tone: 'success', glyph: '!' },
  request: { label: 'request', tone: 'info', glyph: '»' },
  result: { label: 'result', tone: 'success', glyph: '✓' },
  handoff: { label: 'handoff', tone: 'info', glyph: '⇥' },
};

export const EFFORT_UI: Record<AgentEffort, { label: string; tone: Tone; bar: string }> = {
  low: { label: 'Low', tone: 'muted', bar: '▁' },
  medium: { label: 'Medium', tone: 'info', bar: '▃' },
  high: { label: 'High', tone: 'warning', bar: '▆' },
  max: { label: 'Max', tone: 'danger', bar: '█' },
};

/** Tone for a timeline entry, so both surfaces colour the log identically. */
export function eventTone(type: RunEventType, level: 'debug' | 'info' | 'warn' | 'error'): Tone {
  if (level === 'error') return 'danger';
  if (level === 'warn') return 'warning';
  if (level === 'debug') return 'muted';
  switch (type) {
    case 'run_completed':
    case 'task_completed':
      return 'success';
    case 'agent_started':
    case 'task_started':
    case 'run_started':
      return 'active';
    case 'message_sent':
    case 'message_received':
      return 'info';
    default:
      return 'neutral';
  }
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${(minutes % 60).toString().padStart(2, '0')}m`;
}

export function formatClock(date: Date | string | undefined): string {
  if (!date) return '--:--:--';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toTimeString().slice(0, 8);
}

export function formatRelative(date: Date | string | undefined, now = Date.now()): string {
  if (!date) return 'never';
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = now - d.getTime();
  if (!Number.isFinite(diff)) return 'never';
  if (diff < 5_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return `${days}d ago`;
  return d.toISOString().slice(0, 10);
}

export function truncate(text: string, max: number): string {
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

/** A progress bar as text, identical in the terminal and in the browser. */
export function progressBar(percent: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}
