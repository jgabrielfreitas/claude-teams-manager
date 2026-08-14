import { reviveDates } from '@claude-team/protocol';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { client } from '../api';
import type { AppEventDto } from '@claude-team/protocol';

/**
 * The single `EventSource` of the application.
 *
 * Every view subscribes to it and refreshes from what it receives. There is no
 * polling anywhere in this client; if a screen looks stale, the fix is a
 * missing subscription, not a timer.
 */

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'offline';

interface RealtimeValue {
  status: ConnectionStatus;
  lastEventAt?: Date;
  eventCount: number;
  subscribe: (listener: (event: AppEventDto) => void) => () => void;
  reconnect: () => void;
}

const RealtimeContext = createContext<RealtimeValue | undefined>(undefined);

const MAX_BACKOFF_MS = 20_000;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<(event: AppEventDto) => void>());
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [lastEventAt, setLastEventAt] = useState<Date | undefined>();
  const [eventCount, setEventCount] = useState(0);
  const [generation, setGeneration] = useState(0);

  const subscribe = useCallback((listener: (event: AppEventDto) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const reconnect = useCallback(() => setGeneration((n) => n + 1), []);

  useEffect(() => {
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;

    const open = () => {
      if (disposed) return;
      source = new EventSource(client.streamUrl());

      source.onopen = () => {
        attempt = 0;
        setStatus('open');
      };

      source.onmessage = (message) => {
        let event: AppEventDto;
        try {
          event = reviveDates(JSON.parse(message.data) as AppEventDto);
        } catch {
          return;
        }
        setLastEventAt(new Date());
        setEventCount((n) => n + 1);
        for (const listener of [...listeners.current]) {
          try {
            listener(event);
          } catch {
            // A broken subscriber must not break the stream for everyone else.
          }
        }
      };

      source.onerror = () => {
        source?.close();
        if (disposed) return;
        attempt += 1;
        setStatus(attempt > 3 ? 'offline' : 'reconnecting');
        const delay = Math.min(MAX_BACKOFF_MS, 400 * 2 ** Math.min(attempt, 6));
        retryTimer = setTimeout(open, delay);
      };
    };

    setStatus('connecting');
    open();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, [generation]);

  const value = useMemo<RealtimeValue>(
    () => ({ status, lastEventAt, eventCount, subscribe, reconnect }),
    [status, lastEventAt, eventCount, subscribe, reconnect],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeValue {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error('useRealtime must be used inside <RealtimeProvider>');
  return value;
}

/** Runs `handler` for every event matching `filter`. */
export function useAppEvent(
  handler: (event: AppEventDto) => void,
  filter?: (event: AppEventDto) => boolean,
): void {
  const { subscribe } = useRealtime();
  const handlerRef = useRef(handler);
  const filterRef = useRef(filter);
  handlerRef.current = handler;
  filterRef.current = filter;

  useEffect(
    () =>
      subscribe((event) => {
        if (filterRef.current && !filterRef.current(event)) return;
        handlerRef.current(event);
      }),
    [subscribe],
  );
}
