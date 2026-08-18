import type {
  Agent,
  AgentMessage,
  AgentStatus,
  AgentQuestion,
  ApprovalRequest,
  Run,
  RunEvent,
  RunStatus,
  Task,
} from '@claude-team/domain';
import type { AppEventDto, Jsonified } from '@claude-team/protocol';

/**
 * The application's realtime channel (ADR-001).
 *
 * Everything that changes emits here. The TUI subscribes to it directly; the
 * web server subscribes and forwards over SSE. Neither UI polls, and neither
 * has its own notion of "what changed" — there is exactly one event vocabulary.
 */
export type AppEvent =
  | { type: 'run.event'; runId: string; event: RunEvent }
  | { type: 'run.status'; runId: string; status: RunStatus; run?: Run }
  | { type: 'run.created'; run: Run }
  | { type: 'run.deleted'; runId: string }
  | { type: 'agent.status'; agentId: string; status: AgentStatus }
  | { type: 'message'; message: AgentMessage }
  | { type: 'approval'; approval: ApprovalRequest }
  | { type: 'question'; question: AgentQuestion }
  | { type: 'task.changed'; runId: string; task: Task }
  | { type: 'team.changed'; teamId: string | null }
  | { type: 'agent.changed'; agentId: string | null; teamId: string }
  | { type: 'settings.changed' }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string };

/**
 * Compile-time guarantee that the wire contract the browser consumes still
 * matches what the core actually emits. Adding a variant above without adding
 * it to `AppEventDto` fails the build instead of silently leaving the web UI
 * blind to it.
 */
type _AppEventMatchesWireContract = Jsonified<AppEvent> extends AppEventDto ? true : never;
const _appEventContractHolds: _AppEventMatchesWireContract = true;
void _appEventContractHolds;

export type AppEventListener = (event: AppEvent) => void;

export class EventBus {
  private readonly listeners = new Set<AppEventListener>();
  /** Ring buffer so a late subscriber can render immediately. */
  private readonly buffer: AppEvent[] = [];

  constructor(private readonly bufferSize = 500) {}

  subscribe(listener: AppEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: AppEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not take the run down with it.
      }
    }
  }

  /** Recent events, for a UI that just connected. */
  replay(): AppEvent[] {
    return [...this.buffer];
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** Helper for UIs: is this event relevant to the run I am looking at? */
export function eventTouchesRun(event: AppEvent, runId: string): boolean {
  switch (event.type) {
    case 'run.event':
    case 'run.status':
    case 'task.changed':
      return event.runId === runId;
    case 'run.created':
      return event.run.id === runId;
    case 'message':
      return event.message.runId === runId;
    case 'approval':
      return event.approval.runId === runId;
    case 'question':
      return event.question.runId === runId;
    default:
      return false;
  }
}

export type { Agent };
