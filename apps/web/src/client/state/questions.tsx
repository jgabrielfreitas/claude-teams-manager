import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import type { AgentDto, QuestionDto } from '@claude-team/protocol';
import { formatDuration } from '@claude-team/ui-shared';
import { client } from '../api';
import { Modal } from '../components/ui';
import { useAppEvent } from './realtime';
import { useAction } from './toasts';

/**
 * The human answering an agent.
 *
 * Deliberately not the approval centre. An approval answers "may I do this?"
 * with yes or no; a question returns *content* the agent then works from, and
 * the agent is parked until it arrives. Showing one through the other is the
 * bug this exists to prevent: permission gets granted, no answer is ever
 * delivered, and the run stalls until somebody cancels it.
 *
 * Nothing here decides whether an answer is valid — the core rejects a label it
 * never offered, a second choice on a single-choice question and an empty
 * answer, and its message is what the human sees.
 */

interface QuestionsValue {
  /** Questions genuinely still answerable, oldest first. */
  pending: QuestionDto[];
  /** Brings the dialog back — for one question, or for everything set aside. */
  open: (questionId?: string) => void;
}

const QuestionsContext = createContext<QuestionsValue | undefined>(undefined);

export function useQuestions(): QuestionsValue {
  const value = useContext(QuestionsContext);
  if (!value) throw new Error('useQuestions must be used inside <QuestionsProvider>');
  return value;
}

/** Pending questions for one run, for a surface that only cares about that run. */
export function useRunQuestions(runId: string): QuestionsValue['pending'] {
  const { pending } = useQuestions();
  return useMemo(() => pending.filter((q) => q.runId === runId), [pending, runId]);
}

export function QuestionsProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<QuestionDto[]>([]);
  const [setAsideIds, setSetAsideIds] = useState<string[]>([]);
  const [forcedId, setForcedId] = useState<string | undefined>();

  useEffect(() => {
    void client
      .listQuestions()
      .then((pending) => setQueue((current) => merge(current, pending)))
      .catch(() => undefined);
  }, []);

  useAppEvent(
    (event) => {
      if (event.type !== 'question') return;
      const { question } = event;
      if (question.status === 'pending') {
        setQueue((current) => merge(current, [question]));
        return;
      }
      // Answered elsewhere (another tab, the TUI, auto mode, a timeout): stop
      // asking for it here too.
      setQueue((current) => current.filter((q) => q.id !== question.id));
      setSetAsideIds((current) => current.filter((id) => id !== question.id));
      setForcedId((current) => (current === question.id ? undefined : current));
    },
    (event) => event.type === 'question',
  );

  const open = useCallback((questionId?: string) => {
    if (questionId === undefined) {
      setSetAsideIds([]);
      setForcedId(undefined);
      return;
    }
    setSetAsideIds((current) => current.filter((id) => id !== questionId));
    setForcedId(questionId);
  }, []);

  const setAside = useCallback((questionId: string) => {
    setSetAsideIds((current) =>
      current.includes(questionId) ? current : [...current, questionId],
    );
    setForcedId((current) => (current === questionId ? undefined : current));
  }, []);

  const answered = useCallback((questionId: string) => {
    setQueue((current) => current.filter((q) => q.id !== questionId));
    setSetAsideIds((current) => current.filter((id) => id !== questionId));
    setForcedId((current) => (current === questionId ? undefined : current));
  }, []);

  const current =
    (forcedId ? queue.find((q) => q.id === forcedId) : undefined) ??
    queue.find((q) => !setAsideIds.includes(q.id));

  const value = useMemo<QuestionsValue>(
    () => ({
      pending: queue,
      open,
    }),
    [queue, open],
  );

  const waiting = queue.filter((q) => q.id !== current?.id).length;

  return (
    <QuestionsContext.Provider value={value}>
      {children}
      {current && (
        <QuestionDialog
          key={current.id}
          question={current}
          waiting={waiting}
          onSetAside={() => setAside(current.id)}
          onAnswered={() => answered(current.id)}
        />
      )}
    </QuestionsContext.Provider>
  );
}

/* ------------------------------------------------------------------ *
 * The dialog
 * ------------------------------------------------------------------ */

function QuestionDialog({
  question,
  waiting,
  onSetAside,
  onAnswered,
}: {
  question: QuestionDto;
  waiting: number;
  onSetAside: () => void;
  onAnswered: () => void;
}) {
  const act = useAction();
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const agent = useAgent(question.agentId);
  const remaining = useTimeRemaining(question.expiresAt);

  const typingIsTheOnlyWay = question.options.length === 0;
  const canSubmit = selected.length > 0 || text.trim().length > 0;

  const toggle = (label: string) =>
    setSelected((current) => {
      if (!question.allowMultiple) return [label];
      return current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
    });

  const submit = async () => {
    setBusy(true);
    const ok = await act(
      () =>
        client.answerQuestion(question.id, {
          ...(selected.length > 0 ? { selected } : {}),
          ...(text.trim() ? { text: text.trim() } : {}),
        }),
      'Answer sent to the agent',
    );
    setBusy(false);
    if (ok) onAnswered();
  };

  return (
    <Modal
      className="modal-question"
      title={
        <div className="col" style={{ gap: 2, minWidth: 0 }}>
          <span className="question-kicker">Your decision</span>
          <h2 style={{ fontSize: 16 }}>{question.header || 'Question'}</h2>
        </div>
      }
      onClose={onSetAside}
      footer={
        <>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onSetAside}>
            Not now
          </button>
          <span className="right" />
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !canSubmit}
            onClick={() => void submit()}
          >
            Send answer
          </button>
        </>
      }
    >
      <div className="question-blocked">
        <span className="dot busy" />
        <span>
          <strong>{agent?.handle ?? 'An agent'}</strong> is blocked, waiting on this answer — it
          cannot continue until you reply.
          {remaining !== undefined && (
            <>
              {' '}
              If nobody answers within <strong>{formatDuration(remaining)}</strong>, it is told to
              decide for itself and state the assumption.
            </>
          )}
        </span>
      </div>

      <p className="question-text">{question.question}</p>

      {question.options.length > 0 && (
        <fieldset className="question-options">
          <legend className="label">
            {question.allowMultiple ? 'Pick one or more' : 'Pick one'}
          </legend>
          {question.options.map((option) => (
            <label
              key={option.label}
              className={`question-option${selected.includes(option.label) ? ' picked' : ''}`}
            >
              <input
                type={question.allowMultiple ? 'checkbox' : 'radio'}
                name={`question-${question.id}`}
                checked={selected.includes(option.label)}
                onChange={() => toggle(option.label)}
              />
              <span className="col" style={{ gap: 2, minWidth: 0 }}>
                <span className="strong">{option.label}</span>
                {option.description && <span className="small muted">{option.description}</span>}
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {(question.allowFreeform || typingIsTheOnlyWay) && (
        <label className="field">
          <span className="label">
            {typingIsTheOnlyWay ? 'Your answer' : 'Or answer in your own words'}
          </span>
          <textarea
            className="textarea"
            value={text}
            placeholder={typingIsTheOnlyWay ? 'Type your answer…' : 'Optional'}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
      )}

      <div className="row small muted">
        <span>
          Asked by{' '}
          {agent ? (
            <Link to={`/agents/${agent.id}`} className="strong">
              {agent.handle}
            </Link>
          ) : (
            <code>{question.agentId}</code>
          )}
          {agent && ` · ${agent.role}`}
        </span>
        <Link className="btn btn-sm btn-ghost right" to={`/runs/${question.runId}`}>
          Open run
        </Link>
      </div>

      {waiting > 0 && (
        <div className="notice-box">
          {waiting} more question{waiting === 1 ? '' : 's'} waiting behind this one.
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Who is asking, by handle rather than by id. */
function useAgent(agentId: string): AgentDto | undefined {
  const [agent, setAgent] = useState<AgentDto | undefined>();
  useEffect(() => {
    let cancelled = false;
    void client
      .getAgent(agentId)
      .then((result) => !cancelled && setAgent(result))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [agentId]);
  return agent;
}

/**
 * Milliseconds until the core answers on the human's behalf. A local clock, not
 * a poll: nothing is fetched, the deadline came with the question.
 */
function useTimeRemaining(expiresAt: QuestionDto['expiresAt']): number | undefined {
  const deadline = expiresAt ? new Date(expiresAt).getTime() : undefined;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadline === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  if (deadline === undefined || Number.isNaN(deadline)) return undefined;
  return Math.max(0, deadline - now);
}

function merge(current: QuestionDto[], incoming: QuestionDto[]): QuestionDto[] {
  const seen = new Set(current.map((q) => q.id));
  return [...current, ...incoming.filter((q) => !seen.has(q.id) && q.status === 'pending')];
}
