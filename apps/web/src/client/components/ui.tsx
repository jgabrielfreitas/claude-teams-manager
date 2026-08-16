import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AgentEffort } from '@claude-team/domain';
import type { StatusDescriptor, Tone } from '@claude-team/ui-shared';
import { effortUi, toneClass } from '../lib/tone';

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

export function StatusPill({ status, title }: { status: StatusDescriptor; title?: string }) {
  return (
    <span className={`pill ${toneClass(status.tone)}`} title={title ?? status.label}>
      <span className={`dot${status.busy ? ' busy' : ''}`} />
      {status.label}
    </span>
  );
}

export function ModelBadge({ model }: { model: string }) {
  return (
    <span className="badge model" title={`Model: ${model}`}>
      {model}
    </span>
  );
}

export function EffortBadge({ effort }: { effort: AgentEffort }) {
  const ui = effortUi(effort);
  return (
    <span className={`badge effort ${toneClass(ui.tone)}`} title={`Effort: ${ui.label}`}>
      {ui.bar} {ui.label}
    </span>
  );
}

export function ProgressBar({ percent, tone = 'active' }: { percent: number; tone?: Tone }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      className={`progress ${toneClass(tone)}`}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span style={{ width: `${value}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Containers
 * ------------------------------------------------------------------ */

export function Card({
  title,
  actions,
  children,
  flush,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={`card${className ? ` ${className}` : ''}`}>
      {(title || actions) && (
        <header className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions && <div className="actions">{actions}</div>}
        </header>
      )}
      <div className={`card-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {hint && <span className="small muted">{hint}</span>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="empty">
      <span className="spinner" />
      <span className="small muted">{label}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="error-box">
        <span>{error.message}</span>
      </div>
      {onRetry && (
        <div>
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

/** Renders the right thing for a resource in any of its states. */
export function Async<T>({
  resource,
  children,
  empty,
}: {
  resource: { data: T | undefined; error: Error | undefined; loading: boolean; reload: () => void };
  children: (data: T) => ReactNode;
  empty?: ReactNode;
}) {
  if (resource.error) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  if (resource.data === undefined) return resource.loading ? <Loading /> : <>{empty ?? null}</>;
  return <>{children(resource.data)}</>;
}

/* ------------------------------------------------------------------ *
 * Overlays
 * ------------------------------------------------------------------ */

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  dismissable = true,
  className,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  dismissable?: boolean;
  /** Lets a dialog carry its own skin — an approval must not look like a question. */
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>(
      'input, textarea, select, button, [tabindex]:not([tabindex="-1"])',
    )?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissable) {
        event.stopPropagation();
        onClose();
      }
      if (event.key === 'Tab' && ref.current) {
        const focusable = [
          ...ref.current.querySelectorAll<HTMLElement>(
            'a[href], button:not(:disabled), textarea, input, select, [tabindex]:not([tabindex="-1"])',
          ),
        ];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [onClose, dismissable]);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (dismissable && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        ref={ref}
      >
        <header className="modal-head">
          {typeof title === 'string' ? <h2 style={{ fontSize: 15 }}>{title}</h2> : title}
          {dismissable && (
            <button
              type="button"
              className="btn btn-ghost btn-sm right"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          )}
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ *
 * Forms
 * ------------------------------------------------------------------ */

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  toneOf,
}: {
  value: T;
  options: Array<{ value: T; label: string; title?: string }>;
  onChange: (value: T) => void;
  toneOf?: (value: T) => Tone;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          aria-pressed={value === option.value}
          className={toneOf ? toneClass(toneOf(option.value)) : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
