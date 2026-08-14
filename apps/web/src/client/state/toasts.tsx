import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Tone } from '@claude-team/ui-shared';
import { toneClass } from '../lib/tone';

interface Toast {
  id: number;
  tone: Tone;
  message: string;
}

interface ToastValue {
  notify: (message: string, tone?: Tone) => void;
  /** Reports a failed action; API errors already carry a human message. */
  fail: (error: unknown) => void;
}

const ToastContext = createContext<ToastValue | undefined>(undefined);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, tone: Tone = 'info') => {
      const id = nextId++;
      setToasts((current) => [...current, { id, tone, message }]);
      setTimeout(() => dismiss(id), tone === 'danger' ? 8000 : 4000);
    },
    [dismiss],
  );

  const fail = useCallback(
    (error: unknown) => {
      notify(error instanceof Error ? error.message : String(error), 'danger');
    },
    [notify],
  );

  const value = useMemo(() => ({ notify, fail }), [notify, fail]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toneClass(toast.tone)}`}>
            <span className="dot" />
            <span>{toast.message}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm right"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToasts(): ToastValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToasts must be used inside <ToastProvider>');
  return value;
}

/** Wraps an async action with error reporting, so no component swallows one. */
export function useAction(): (fn: () => Promise<unknown>, success?: string) => Promise<boolean> {
  const { fail, notify } = useToasts();
  return useCallback(
    async (fn, success) => {
      try {
        await fn();
        if (success) notify(success, 'success');
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    [fail, notify],
  );
}
