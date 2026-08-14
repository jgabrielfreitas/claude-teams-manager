import type { RunStatus, TaskStatus } from './entities.js';
import { illegalState } from './errors.js';

/**
 * Explicit state machines. Keeping them here (rather than inside the runtime)
 * means both UIs can grey out impossible actions using the same rules the
 * engine enforces.
 */

const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['paused', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw illegalState(`Cannot move a run from "${from}" to "${to}"`, { from, to });
  }
}

/** Actions the UI may offer for a run in a given state. */
export type RunAction = 'start' | 'pause' | 'resume' | 'cancel' | 'retry';

export function availableRunActions(status: RunStatus): RunAction[] {
  switch (status) {
    case 'queued':
      return ['start', 'cancel'];
    case 'running':
      return ['pause', 'cancel'];
    case 'paused':
      return ['resume', 'cancel'];
    case 'completed':
      return ['retry'];
    case 'failed':
    case 'cancelled':
      return ['retry'];
    default:
      return [];
  }
}

const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['ready', 'blocked', 'cancelled', 'running'],
  ready: ['running', 'blocked', 'pending', 'cancelled'],
  running: ['review', 'completed', 'failed', 'blocked', 'cancelled'],
  blocked: ['pending', 'ready', 'cancelled', 'failed'],
  review: ['completed', 'failed', 'running', 'cancelled'],
  completed: ['running'], // reopened by the orchestrator when a reviewer rejects
  failed: ['pending', 'ready', 'running', 'cancelled'], // retry
  cancelled: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TASK_TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw illegalState(`Cannot move a task from "${from}" to "${to}"`, { from, to });
  }
}
