import { useCallback, useEffect, useRef, useState } from 'react';
import { useInput, useStdin, useStdout, type Key } from 'ink';

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

export type KeyHandler = (input: string, key: Key) => void;

/**
 * `useInput` that is safe when stdin is not a TTY (piped output, CI, our own
 * headless smoke tests). Ink throws in that case, so we simply never activate.
 */
export function useKeys(handler: KeyHandler, active = true): void {
  const { isRawModeSupported } = useStdin();
  // Must be a real boolean: Ink only skips the hook on an exact `false`.
  useInput(handler, { isActive: Boolean(active && isRawModeSupported) });
}

/** True when the terminal can actually deliver keystrokes. */
export function useRawMode(): boolean {
  return Boolean(useStdin().isRawModeSupported);
}

/* ------------------------------------------------------------------ *
 * Terminal size
 * ------------------------------------------------------------------ */

export interface TerminalSize {
  columns: number;
  rows: number;
  /** Too narrow for two panes side by side. */
  narrow: boolean;
  /** Too short to afford chrome (footer/legend). */
  short: boolean;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const read = useCallback((): { columns: number; rows: number } => {
    // Match Ink's own fallback so layout maths and output agree off-TTY.
    return { columns: stdout?.columns || 80, rows: stdout?.rows || 24 };
  }, [stdout]);

  const [size, setSize] = useState(read);

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize(read());
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout, read]);

  return {
    columns: size.columns,
    rows: size.rows,
    narrow: size.columns < 72,
    short: size.rows < 16,
  };
}

/* ------------------------------------------------------------------ *
 * Async data
 * ------------------------------------------------------------------ */

export interface LoaderState<T> {
  data?: T;
  error?: string;
  loading: boolean;
}

/**
 * Loads data whenever `deps` change. There is no polling anywhere in this app:
 * views re-run their loader because an `AppEvent` bumped a revision counter.
 */
export function useLoader<T>(load: () => Promise<T>, deps: unknown[]): LoaderState<T> {
  const [state, setState] = useState<LoaderState<T>>({ loading: true });
  const token = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const current = ++token.current;
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));
    loadRef
      .current()
      .then((data) => {
        if (cancelled || current !== token.current) return;
        setState({ data, loading: false });
      })
      .catch((err: unknown) => {
        if (cancelled || current !== token.current) return;
        setState({ error: errorMessage(err), loading: false });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/* ------------------------------------------------------------------ *
 * List navigation
 * ------------------------------------------------------------------ */

export interface ListNav {
  index: number;
  setIndex: (index: number) => void;
}

/** Cursor state for a vertical list, driven by arrows / j / k / home / end. */
export function useListNav(count: number, active: boolean, onMove?: (index: number) => void): ListNav {
  const [index, setIndexState] = useState(0);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const setIndex = useCallback((next: number) => {
    setIndexState(next);
    onMoveRef.current?.(next);
  }, []);

  useEffect(() => {
    if (count === 0) return;
    if (index > count - 1) setIndex(count - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  useKeys((input, key) => {
    if (count === 0) return;
    if (key.upArrow || input === 'k') setIndex(Math.max(0, index - 1));
    else if (key.downArrow || input === 'j') setIndex(Math.min(count - 1, index + 1));
    else if (key.pageUp) setIndex(Math.max(0, index - 10));
    else if (key.pageDown) setIndex(Math.min(count - 1, index + 10));
    else if (input === 'g') setIndex(0);
    else if (input === 'G') setIndex(count - 1);
  }, active);

  return { index: Math.min(index, Math.max(0, count - 1)), setIndex };
}

/** The slice of a list that fits on screen, keeping the cursor visible. */
export function windowOf<T>(items: T[], index: number, height: number): { slice: T[]; offset: number } {
  if (height <= 0 || items.length <= height) return { slice: items, offset: 0 };
  const half = Math.floor(height / 2);
  const offset = Math.max(0, Math.min(items.length - height, index - half));
  return { slice: items.slice(offset, offset + height), offset };
}
