import { createEvent, type CreateEventInput, type RunEvent } from '@claude-team/domain';
import type { Storage } from '@claude-team/persistence';

/**
 * Single writer for a run's timeline.
 *
 * Every observable thing that happens goes through here: it allocates the
 * sequence number, persists the event, then notifies subscribers. Because the
 * timeline is persisted before it is broadcast, a UI that reconnects can
 * always catch up from `afterSeq` without missing anything (ADR-002).
 */
export class EventRecorder {
  constructor(
    private readonly storage: Storage,
    private readonly notify: (event: RunEvent) => void = () => {},
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async record(input: Omit<CreateEventInput, 'seq'>): Promise<RunEvent> {
    const seq = await this.storage.events.nextSeq(input.runId);
    const event = createEvent({ ...input, seq }, this.clock());
    await this.storage.events.append(event);
    try {
      this.notify(event);
    } catch {
      // A misbehaving subscriber must never break the run.
    }
    return event;
  }
}
