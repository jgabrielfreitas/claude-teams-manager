import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useApp } from 'ink';
import type { AppCore } from '@claude-team/core';
import type { AppEvent } from '@claude-team/core';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ToolGroupDescriptor,
  ToolPermission,
} from '@claude-team/domain';
import type { SectionId, Tone } from '@claude-team/ui-shared';
import { errorMessage } from './lib/hooks.js';

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

export type Overlay = 'palette' | 'search' | 'help' | null;

/** Which layer currently owns the keyboard. */
export type Lock = 'view' | 'overlay' | 'dialog' | 'approval';

export interface Selection {
  teamId?: string;
  agentId?: string;
  runId?: string;
}

export type RevKey = 'teams' | 'agents' | 'runs' | 'events' | 'messages' | 'settings' | 'approvals';

export interface SelectItem {
  value: string;
  label: string;
  hint?: string;
  tone?: Tone;
}

export interface TextDialogOptions {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  /** Shown under the input, e.g. what the value is used for. */
  help?: string;
}

export interface SelectDialogOptions {
  title: string;
  items: SelectItem[];
  help?: string;
  initialValue?: string;
}

export interface MultiSelectDialogOptions {
  title: string;
  items: SelectItem[];
  selected: string[];
  help?: string;
}

export interface ConfirmDialogOptions {
  title: string;
  message?: string;
  danger?: boolean;
}

export interface PermissionsDialogOptions {
  title: string;
  permissions: ToolPermission[];
  /** Catalogue from `core.listToolGroups()` — the TUI never invents groups. */
  groups: ToolGroupDescriptor[];
}

export interface InfoDialogOptions {
  title: string;
  lines: string[];
}

export type DialogRequest =
  | ({ kind: 'text'; id: number; resolve: (v: string | undefined) => void } & TextDialogOptions)
  | ({ kind: 'select'; id: number; resolve: (v: string | undefined) => void } & SelectDialogOptions)
  | ({
      kind: 'multiselect';
      id: number;
      resolve: (v: string[] | undefined) => void;
    } & MultiSelectDialogOptions)
  | ({ kind: 'confirm'; id: number; resolve: (v: boolean) => void } & ConfirmDialogOptions)
  | ({
      kind: 'permissions';
      id: number;
      resolve: (v: ToolPermission[] | undefined) => void;
    } & PermissionsDialogOptions)
  | ({ kind: 'info'; id: number; resolve: () => void } & InfoDialogOptions);

export interface Dialogs {
  text(options: TextDialogOptions): Promise<string | undefined>;
  select(options: SelectDialogOptions): Promise<string | undefined>;
  multiselect(options: MultiSelectDialogOptions): Promise<string[] | undefined>;
  confirm(options: ConfirmDialogOptions): Promise<boolean>;
  permissions(options: PermissionsDialogOptions): Promise<ToolPermission[] | undefined>;
  info(options: InfoDialogOptions): Promise<void>;
}

export interface StatusLine {
  message: string;
  tone: Tone;
}

export interface Ui {
  core: AppCore;
  providerId: string;

  section: SectionId;
  setSection: (section: SectionId) => void;

  selection: Selection;
  select: (patch: Selection) => void;

  focus: 'list' | 'detail';
  setFocus: (focus: 'list' | 'detail') => void;
  toggleFocus: () => void;

  overlay: Overlay;
  setOverlay: (overlay: Overlay) => void;

  /** Runs section: follow the live timeline, or step through it. */
  runMode: 'live' | 'replay';
  setRunMode: (mode: 'live' | 'replay') => void;

  /** True while the onboarding wizard owns the screen. */
  onboarding: boolean;
  setOnboarding: (value: boolean) => void;

  lock: Lock;

  status?: StatusLine;
  notify: (message: string, tone?: Tone) => void;

  /** Runs a core call, turning any failure into a status line instead of a crash. */
  guard: <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>;

  /**
   * Starts an action from a place that cannot await it — a key handler, an
   * effect. The rejection lands on the status line instead of becoming an
   * unhandled rejection, which on Node ≥ 15 would tear the process down
   * mid-render and leave the terminal in raw mode.
   */
  dispatch: (action: () => Promise<unknown>) => void;

  /** Revision counter for the given event families; use it as an effect dep. */
  rev: (keys: RevKey[]) => number;

  approvals: ApprovalRequest[];
  decideApproval: (approvalId: string, decision: ApprovalDecision) => void;

  dialogs: Dialogs;
  dialogQueue: DialogRequest[];
  resolveDialog: (id: number, value: unknown) => void;

  quit: () => void;
}

const UiContext = createContext<Ui | undefined>(undefined);

export function useUi(): Ui {
  const value = useContext(UiContext);
  if (!value) throw new Error('useUi must be used inside <UiProvider>');
  return value;
}

/* ------------------------------------------------------------------ *
 * Event → revision mapping
 * ------------------------------------------------------------------ */

function keysForEvent(event: AppEvent): RevKey[] {
  switch (event.type) {
    case 'run.event':
      return ['events', 'runs'];
    case 'run.status':
    case 'run.created':
      return ['runs', 'events'];
    case 'task.changed':
      return ['runs', 'events'];
    case 'agent.status':
      return ['agents', 'teams'];
    case 'agent.changed':
      return ['agents', 'teams'];
    case 'team.changed':
      return ['teams', 'agents'];
    case 'message':
      return ['messages', 'events'];
    case 'approval':
      return ['approvals', 'events'];
    case 'settings.changed':
      return ['settings'];
    case 'notice':
      return [];
    default:
      return [];
  }
}

const ZERO_REVS: Record<RevKey, number> = {
  teams: 0,
  agents: 0,
  runs: 0,
  events: 0,
  messages: 0,
  settings: 0,
  approvals: 0,
};

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

export interface UiProviderProps {
  core: AppCore;
  providerId: string;
  initialSection?: SectionId;
  initialSelection?: Selection;
  initialOnboarding?: boolean;
  children: ReactNode;
}

export function UiProvider({
  core,
  providerId,
  initialSection = 'dashboard',
  initialSelection = {},
  initialOnboarding = false,
  children,
}: UiProviderProps): React.JSX.Element {
  const app = useApp();

  const [section, setSection] = useState<SectionId>(initialSection);
  const [selection, setSelection] = useState<Selection>(initialSelection);
  const [focus, setFocus] = useState<'list' | 'detail'>('list');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [runMode, setRunMode] = useState<'live' | 'replay'>('live');
  const [onboarding, setOnboarding] = useState(initialOnboarding);
  const [status, setStatus] = useState<StatusLine | undefined>();
  const [revs, setRevs] = useState<Record<RevKey, number>>(ZERO_REVS);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [dialogQueue, setDialogQueue] = useState<DialogRequest[]>([]);

  const statusTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const dialogId = useRef(0);

  const notify = useCallback((message: string, tone: Tone = 'info') => {
    setStatus({ message, tone });
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(undefined), 8000);
  }, []);

  useEffect(() => () => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
  }, []);

  const guard = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      try {
        const result = await fn();
        if (success) notify(success, 'success');
        return result;
      } catch (err) {
        notify(errorMessage(err), 'danger');
        return undefined;
      }
    },
    [notify],
  );

  const dispatch = useCallback(
    (action: () => Promise<unknown>) => {
      try {
        void action().catch((err: unknown) => notify(errorMessage(err), 'danger'));
      } catch (err) {
        // A throw before the first await never produced a promise.
        notify(errorMessage(err), 'danger');
      }
    },
    [notify],
  );

  /* -------- realtime: one subscription, coalesced bursts -------- */

  useEffect(() => {
    const pending = new Set<RevKey>();
    let timer: NodeJS.Timeout | undefined;

    const flush = () => {
      timer = undefined;
      if (pending.size === 0) return;
      const keys = [...pending];
      pending.clear();
      setRevs((prev) => {
        const next = { ...prev };
        for (const key of keys) next[key] = prev[key] + 1;
        return next;
      });
    };

    const unsubscribe = core.subscribe((event) => {
      // A blocked agent is waiting on this one — never coalesce it.
      if (event.type === 'approval') {
        setApprovals((prev) => {
          const without = prev.filter((a) => a.id !== event.approval.id);
          return event.approval.status === 'pending' ? [...without, event.approval] : without;
        });
      }
      if (event.type === 'notice') {
        setStatus({
          message: event.message,
          tone: event.level === 'error' ? 'danger' : event.level === 'warn' ? 'warning' : 'info',
        });
      }
      for (const key of keysForEvent(event)) pending.add(key);
      if (!timer) timer = setTimeout(flush, 150);
    });

    // Anything that was already waiting before we attached.
    void core
      .listPendingApprovals()
      .then((list) => setApprovals((prev) => (prev.length === 0 ? list : prev)))
      .catch(() => undefined);

    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [core]);

  const rev = useCallback((keys: RevKey[]) => keys.reduce((sum, key) => sum + revs[key], 0), [revs]);

  const decideApproval = useCallback(
    (approvalId: string, decision: ApprovalDecision) => {
      setApprovals((prev) => prev.filter((a) => a.id !== approvalId));
      dispatch(() =>
        guard(
          () => core.resolveApproval({ approvalId, decision, decidedBy: 'user' }),
          `Approval ${decision.replace('_', ' ')}.`,
        ),
      );
    },
    [core, guard, dispatch],
  );

  /* -------- dialogs -------- */

  const push = useCallback(<T,>(build: (id: number, resolve: (value: T) => void) => DialogRequest) => {
    return new Promise<T>((resolve) => {
      const id = ++dialogId.current;
      setDialogQueue((prev) => [...prev, build(id, resolve)]);
    });
  }, []);

  const resolveDialog = useCallback((id: number, value: unknown) => {
    setDialogQueue((prev) => {
      const request = prev.find((d) => d.id === id);
      if (request) (request.resolve as (v: unknown) => void)(value);
      return prev.filter((d) => d.id !== id);
    });
  }, []);

  const dialogs = useMemo<Dialogs>(
    () => ({
      text: (options) =>
        push<string | undefined>((id, resolve) => ({ kind: 'text', id, resolve, ...options })),
      select: (options) =>
        push<string | undefined>((id, resolve) => ({ kind: 'select', id, resolve, ...options })),
      multiselect: (options) =>
        push<string[] | undefined>((id, resolve) => ({
          kind: 'multiselect',
          id,
          resolve,
          ...options,
        })),
      confirm: (options) => push<boolean>((id, resolve) => ({ kind: 'confirm', id, resolve, ...options })),
      permissions: (options) =>
        push<ToolPermission[] | undefined>((id, resolve) => ({
          kind: 'permissions',
          id,
          resolve,
          ...options,
        })),
      info: (options) => push<void>((id, resolve) => ({ kind: 'info', id, resolve, ...options })),
    }),
    [push],
  );

  const select = useCallback((patch: Selection) => {
    setSelection((prev) => ({ ...prev, ...patch }));
  }, []);

  const toggleFocus = useCallback(() => {
    setFocus((prev) => (prev === 'list' ? 'detail' : 'list'));
  }, []);

  const quit = useCallback(() => {
    app.exit();
  }, [app]);

  const lock: Lock =
    approvals.length > 0
      ? 'approval'
      : dialogQueue.length > 0
        ? 'dialog'
        : overlay
          ? 'overlay'
          : 'view';

  const value = useMemo<Ui>(
    () => ({
      core,
      providerId,
      section,
      setSection,
      selection,
      select,
      focus,
      setFocus,
      toggleFocus,
      overlay,
      setOverlay,
      runMode,
      setRunMode,
      onboarding,
      setOnboarding,
      lock,
      status,
      notify,
      guard,
      dispatch,
      rev,
      approvals,
      decideApproval,
      dialogs,
      dialogQueue,
      resolveDialog,
      quit,
    }),
    [
      core,
      providerId,
      section,
      selection,
      select,
      focus,
      toggleFocus,
      overlay,
      runMode,
      onboarding,
      lock,
      status,
      notify,
      guard,
      dispatch,
      rev,
      approvals,
      decideApproval,
      dialogs,
      dialogQueue,
      resolveDialog,
      quit,
    ],
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}
