import type { Task, TaskStatus } from './entities.js';
import { DomainError } from './errors.js';

/**
 * Pure task-graph logic. The scheduler in `@claude-team/runtime` is a thin
 * driver on top of these functions, which keeps dependency resolution unit
 * testable without a database or a provider.
 */

export interface TaskGraphView {
  tasks: Task[];
  byId: Map<string, Task>;
}

export function buildGraph(tasks: Task[]): TaskGraphView {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

/**
 * Returns every dependency cycle in the graph, each as the list of task ids
 * that form it. An empty array means the graph is a DAG.
 */
export function findCycles(tasks: Task[]): string[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      const start = stack.indexOf(id);
      const cycle = stack.slice(start).concat(id);
      const key = [...cycle].sort().join('>');
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(cycle);
      }
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of byId.get(id)?.dependencies ?? []) {
      if (byId.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(id, 'done');
  };

  for (const t of tasks) visit(t.id);
  return cycles;
}

/** Throws when adding `dependencies` to `taskId` would introduce a cycle. */
export function assertNoCycle(tasks: Task[], taskId: string, dependencies: string[]): void {
  const patched = tasks.map((t) => (t.id === taskId ? { ...t, dependencies } : t));
  const cycles = findCycles(patched);
  if (cycles.length > 0) {
    throw new DomainError(
      'cycle_detected',
      `Dependency cycle detected: ${cycles[0].join(' -> ')}`,
      { cycle: cycles[0] },
    );
  }
}

/** Dependency ids that are missing from the graph entirely. */
export function danglingDependencies(tasks: Task[]): Array<{ taskId: string; missing: string[] }> {
  const known = new Set(tasks.map((t) => t.id));
  const out: Array<{ taskId: string; missing: string[] }> = [];
  for (const t of tasks) {
    const missing = t.dependencies.filter((d) => !known.has(d));
    if (missing.length) out.push({ taskId: t.id, missing });
  }
  return out;
}

/**
 * Recomputes derived task statuses from the dependency graph.
 *
 * - `pending` becomes `ready` once every dependency is `completed`.
 * - `pending`/`ready` becomes `blocked` when any dependency failed or was
 *   cancelled — the task cannot run until the orchestrator intervenes.
 * - `blocked` returns to `pending`/`ready` when the blocking dependency
 *   recovers (e.g. after a retry).
 *
 * Returns only the tasks whose status actually changed.
 */
export function recomputeTaskStatuses(tasks: Task[], now = new Date()): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const changed: Task[] = [];

  for (const task of tasks) {
    if (task.status === 'running' || task.status === 'review') continue;
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') continue;

    const deps = task.dependencies.map((id) => byId.get(id)).filter(Boolean) as Task[];
    const hasBroken = deps.some((d) => d.status === 'failed' || d.status === 'cancelled');
    const allDone = deps.every((d) => d.status === 'completed');

    let next: TaskStatus;
    if (hasBroken) next = 'blocked';
    else if (allDone) next = 'ready';
    else next = 'pending';

    if (next !== task.status) {
      task.status = next;
      task.updatedAt = now;
      changed.push(task);
    }
  }

  return changed;
}

/** Tasks that can be dispatched right now, in deterministic order. */
export function readyTasks(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => t.status === 'ready')
    .sort((a, b) => a.order - b.order || a.createdAt.getTime() - b.createdAt.getTime());
}

/** True when every task has reached a terminal state. */
export function allTasksSettled(tasks: Task[]): boolean {
  return tasks.every(
    (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled',
  );
}

/**
 * True when nothing is running and nothing can start, yet unfinished work
 * remains — the scheduler must hand control back to the orchestrator.
 */
export function isStalled(tasks: Task[]): boolean {
  if (tasks.length === 0) return false;
  if (allTasksSettled(tasks)) return false;
  const running = tasks.some((t) => t.status === 'running' || t.status === 'review');
  const runnable = tasks.some((t) => t.status === 'ready');
  return !running && !runnable;
}

/** Topological order (dependencies first). Falls back to insertion order inside a cycle. */
export function topologicalOrder(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const inProgress = new Set<string>();
  const out: Task[] = [];

  const visit = (task: Task): void => {
    if (visited.has(task.id) || inProgress.has(task.id)) return;
    inProgress.add(task.id);
    for (const dep of task.dependencies) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    inProgress.delete(task.id);
    visited.add(task.id);
    out.push(task);
  };

  for (const t of [...tasks].sort((a, b) => a.order - b.order)) visit(t);
  return out;
}

/** Direct dependents of a task (tasks that list it as a dependency). */
export function dependentsOf(tasks: Task[], taskId: string): Task[] {
  return tasks.filter((t) => t.dependencies.includes(taskId));
}

export interface TaskProgress {
  total: number;
  completed: number;
  failed: number;
  running: number;
  blocked: number;
  pending: number;
  percent: number;
}

export function taskProgress(tasks: Task[]): TaskProgress {
  const total = tasks.length;
  const count = (s: TaskStatus | TaskStatus[]) =>
    tasks.filter((t) => (Array.isArray(s) ? s.includes(t.status) : t.status === s)).length;
  const completed = count('completed');
  return {
    total,
    completed,
    failed: count(['failed', 'cancelled']),
    running: count(['running', 'review']),
    blocked: count('blocked'),
    pending: count(['pending', 'ready']),
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}
