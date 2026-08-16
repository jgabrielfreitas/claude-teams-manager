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
import type { AppEvent, TranscriptFormat } from '@claude-team/core';
import type {
  AgentQuestion,
  AppSettings,
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

/**
 * Which layer currently owns the keyboard.
 *
 * `approval` and `question` are separate on purpose: one grants a permission,
 * the other delivers an answer the agent then works from. They are never the
 * same prompt.
 */
export type Lock = 'view' | 'overlay' | 'dialog' | 'approval' | 'question';

export interface Selection {
  teamId?: string;
  agentId?: string;
  runId?: string;
}

export type RevKey =
  | 'teams'
  | 'agents'
  | 'runs'
  | 'events'
  | 'messages'
  | 'settings'
  | 'approvals'
  | 'questions';

/** What the human sends back to a blocked agent. */
export interface QuestionAnswer {
  /** Labels picked from the offered options. */
  selected?: string[];
  /** Free-text answer. */
  text?: string;
}

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

/**
 * What `y` and `e` will produce. Kept next to the rest of the UI state — and
 * not inside the full-screen view — so the footer, the copy and the export all
 * read the same choice, and so it survives leaving the view and coming back.
 */
export interface TranscriptPrefs {
  format: TranscriptFormat;
  includeDebug: boolean;
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

  /** True while one run owns the whole terminal (no list, no side panel). */
  runFullScreen: boolean;
  setRunFullScreen: (value: boolean) => void;

  /** Format and detail used by the copy and export actions. */
  transcript: TranscriptPrefs;
  setTranscriptFormat: (format: TranscriptFormat) => void;
  setTranscriptIncludeDebug: (value: boolean) => void;

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

  /** Questions still waiting for a human answer, oldest first. */
  questions: AgentQuestion[];
  /** The one the prompt is showing; undefined once it has been dismissed. */
  activeQuestion?: AgentQuestion;
  /** Sends the answer. The core validates it; failures reach the status line. */
  answerQuestion: (questionId: string, answer: QuestionAnswer) => void;
  /** Closes the prompt *without* answering — the question stays pending. */
  dismissQuestion: (questionId: string) => void;
  /** Brings a dismissed prompt back, optionally reseeded from the core. */
  reopenQuestion: (pending?: AgentQuestion[]) => void;

  /** Last known settings, refreshed from `settings.changed`. */
  settings?: AppSettings;
  /** True when approvals *and* questions are both handled automatically. */
  autoMode: boolean;
  setAutoMode: (value: boolean) => void;
  toggleAutoMode: () => void;

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
    case 'question':
      return ['questions', 'events'];
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
  questions: 0,
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
  const [runFullScreen, setRunFullScreen] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptPrefs>({
    // The default the core itself uses; debug events stay out until asked for.
    format: 'markdown',
    includeDebug: false,
  });
  const [onboarding, setOnboarding] = useState(initialOnboarding);
  const [status, setStatus] = useState<StatusLine | undefined>();
  const [revs, setRevs] = useState<Record<RevKey, number>>(ZERO_REVS);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [questions, setQuestions] = useState<AgentQuestion[]>([]);
  // Questions whose prompt the user closed with `esc`. They are still pending
  // — this is only about what is on screen.
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [settings, setSettings] = useState<AppSettings | undefined>();
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
      // An agent is parked on this one until a human answers — never coalesce
      // it either, and never let it share the approval queue.
      if (event.type === 'question') {
        const { question } = event;
        setQuestions((prev) => {
          const without = prev.filter((q) => q.id !== question.id);
          return question.status === 'pending' ? [...without, question] : without;
        });
        // Answered, expired or auto-answered: nothing left to reopen.
        if (question.status !== 'pending') {
          setDismissed((prev) => prev.filter((id) => id !== question.id));
        }
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
    void core
      .listPendingQuestions()
      .then((list) => setQuestions((prev) => (prev.length === 0 ? list : prev)))
      .catch(() => undefined);

    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [core]);

  const rev = useCallback((keys: RevKey[]) => keys.reduce((sum, key) => sum + revs[key], 0), [revs]);

  /* -------- settings: the header indicator reads this -------- */

  useEffect(() => {
    let cancelled = false;
    void core
      .getSettings()
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [core, revs.settings]);

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

  /* -------- questions -------- */

  /**
   * The core owns every rule about what a valid answer is (a label that was
   * offered, one choice unless the question allows several, nothing empty), so
   * the call is simply made and any refusal becomes a status line. The queue
   * only drops the question once the core has accepted the answer.
   */
  const answerQuestion = useCallback(
    (questionId: string, answer: QuestionAnswer) => {
      dispatch(async () => {
        const result = await guard(
          () =>
            core.answerQuestion({
              questionId,
              selected: answer.selected,
              text: answer.text,
              answeredBy: 'user',
            }),
          'Answer delivered — the agent is no longer blocked.',
        );
        if (result) {
          setQuestions((prev) => prev.filter((q) => q.id !== questionId));
          setDismissed((prev) => prev.filter((id) => id !== questionId));
        }
      });
    },
    [core, guard, dispatch],
  );

  const dismissQuestion = useCallback(
    (questionId: string) => {
      setDismissed((prev) => (prev.includes(questionId) ? prev : [...prev, questionId]));
      notify('Dismissed without answering — the agent is still waiting. Press Q to answer it.', 'warning');
    },
    [notify],
  );

  const reopenQuestion = useCallback(
    (pending?: AgentQuestion[]) => {
      if (pending) setQuestions(pending);
      setDismissed([]);
    },
    [],
  );

  /* -------- auto mode -------- */

  const setAutoMode = useCallback(
    (value: boolean) => {
      dispatch(() =>
        guard(
          () => core.updateSettings({ autoApproveAll: value, autoAnswerQuestions: value }),
          value
            ? 'Auto mode ON — the run never stops to ask: permissions are granted automatically and a question is answered with "decide it yourself and state the assumption".'
            : 'Auto mode OFF — approvals and questions block the run again until you answer them.',
        ),
      );
    },
    [core, guard, dispatch],
  );

  const toggleAutoMode = useCallback(() => {
    // Read the current value through the core rather than from local state, so
    // the toggle cannot act on a stale snapshot.
    dispatch(async () => {
      const current = await core.getSettings();
      setAutoMode(!(current.autoApproveAll && current.autoAnswerQuestions));
    });
  }, [core, dispatch, setAutoMode]);

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

  const setTranscriptFormat = useCallback((format: TranscriptFormat) => {
    setTranscript((prev) => ({ ...prev, format }));
  }, []);

  const setTranscriptIncludeDebug = useCallback((includeDebug: boolean) => {
    setTranscript((prev) => ({ ...prev, includeDebug }));
  }, []);

  const quit = useCallback(() => {
    app.exit();
  }, [app]);

  const activeQuestion = questions.find((question) => !dismissed.includes(question.id));
  const autoMode = Boolean(settings?.autoApproveAll && settings?.autoAnswerQuestions);

  const lock: Lock =
    approvals.length > 0
      ? 'approval'
      : activeQuestion
        ? 'question'
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
      runFullScreen,
      setRunFullScreen,
      transcript,
      setTranscriptFormat,
      setTranscriptIncludeDebug,
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
      questions,
      activeQuestion,
      answerQuestion,
      dismissQuestion,
      reopenQuestion,
      settings,
      autoMode,
      setAutoMode,
      toggleAutoMode,
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
      runFullScreen,
      transcript,
      setTranscriptFormat,
      setTranscriptIncludeDebug,
      onboarding,
      lock,
      status,
      notify,
      guard,
      dispatch,
      rev,
      approvals,
      decideApproval,
      questions,
      activeQuestion,
      answerQuestion,
      dismissQuestion,
      reopenQuestion,
      settings,
      autoMode,
      setAutoMode,
      toggleAutoMode,
      dialogs,
      dialogQueue,
      resolveDialog,
      quit,
    ],
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}
