import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import type { AppEventDto } from '@claude-team/protocol';
import { useRealtime } from '../state/realtime';

/**
 * Loads data from the API and re-loads it when the realtime stream says the
 * underlying data changed. Deliberately not a polling hook.
 */

export interface Resource<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  /** True while a refresh runs over data that is already on screen. */
  refreshing: boolean;
  reload: () => void;
}

const REFRESH_DEBOUNCE_MS = 180;

export function useResource<T>(
  loader: () => Promise<T>,
  deps: DependencyList,
  watch?: (event: AppEventDto) => boolean,
): Resource<T> {
  const { subscribe } = useRealtime();
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const watchRef = useRef(watch);
  watchRef.current = watch;

  const requestId = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (isRefresh: boolean) => {
    const id = ++requestId.current;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const next = await loaderRef.current();
      if (!mounted.current || id !== requestId.current) return;
      setData(next);
      setError(undefined);
    } catch (err) {
      if (!mounted.current || id !== requestId.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (mounted.current && id === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  // Initial load (and whenever the caller's identity deps change).
  useEffect(() => {
    void run(false);
    // `run` is a stable callback that reads the latest loader through a ref, so
    // it is deliberately not a dependency; `deps` is the caller's list, which
    // the rule cannot verify statically for a generic hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Event-driven refresh, coalesced so a burst of run events costs one request.
  useEffect(() => {
    if (!watchRef.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe((event) => {
      if (!watchRef.current?.(event)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(true), REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
    // Same reasoning as above: `run` and `watch` are reached through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, ...deps]);

  const reload = useCallback(() => void run(true), [run]);

  return { data, error, loading, refreshing, reload };
}
