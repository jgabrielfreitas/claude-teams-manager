import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { availableRunActions, formatUsd, type RunAction } from '@claude-team/domain';
import type { RunDetailDto } from '@claude-team/protocol';
import { formatDuration, formatRelative, runDurationMs } from '@claude-team/ui-shared';
import { client } from '../api';
import { AgentAvatar } from '../components/agent-views';
import { isTypingTarget } from '../components/layout';
import { RunExportControls, useExportPrefs } from '../components/run-export';
import {
  FULL_SCREEN_TABS,
  FullScreenRun,
  type FullScreenTab,
} from '../components/run-fullscreen';
import {
  Conversation,
  DEFAULT_CONVERSATION_PREFS,
  type ConversationPrefs,
} from '../components/conversation';
import {
  RunTotals,
  TaskBoard,
  TaskProgressSummary,
  Timeline,
} from '../components/run-views';
import {
  Async,
  Card,
  EffortBadge,
  EmptyState,
  Field,
  Modal,
  ModelBadge,
  StatusPill,
} from '../components/ui';
import { useResource } from '../hooks/use-resource';
import { runStatusUi } from '../lib/tone';
import { eventTouchesRun } from '@claude-team/protocol';
import type { QuestionDto } from '@claude-team/protocol';
import { useQuestions, useRunQuestions } from '../state/questions';
import { useDeclareSelection } from '../state/selection';
import { useAction } from '../state/toasts';

/**
 * The conversation is what people come to read, so it opens first and the
 * timeline sits behind it as the log it is.
 */
type Tab = 'conversation' | 'tasks' | 'timeline';

const ACTION_LABEL: Record<RunAction, string> = {
  start: 'Start',
  pause: 'Pause',
  resume: 'Resume',
  cancel: 'Cancel',
  retry: 'Retry',
};

/**
 * A single run: the plan, the timeline, the conversation and the exact
 * configuration each agent ran with. Which buttons exist is decided by the
 * shared state machine (`availableRunActions`), not by this component.
 */
export function RunDetailPage() {
  const { runId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const act = useAction();

  const detail = useResource<RunDetailDto>(
    () => client.getRun(runId),
    [runId],
    (event) => eventTouchesRun(event, runId),
  );

  useDeclareSelection({ runId, runStatus: detail.data?.run.status });

  // Anything unrecognised — including `messages`, which links made before the
  // conversation existed still carry — reads as the conversation rather than
  // rendering an empty panel.
  const TABS: Tab[] = ['conversation', 'tasks', 'timeline'];
  const requestedTab = params.get('tab') as Tab | null;
  const tab: Tab = requestedTab && TABS.includes(requestedTab) ? requestedTab : 'conversation';
  const focusTaskId = params.get('task') ?? undefined;
  const replaying = params.get('replay') === '1';
  // Full screen lives in the URL so a refresh keeps it and a link can open it.
  const fullScreen = params.get('full') === '1';
  const requestedFullTab = params.get('view') as FullScreenTab | null;
  const fullTab: FullScreenTab =
    requestedFullTab && FULL_SCREEN_TABS.includes(requestedFullTab)
      ? requestedFullTab
      : 'conversation';

  const setParam = useCallback(
    (key: string, value?: string) => {
      const next = new URLSearchParams(params);
      if (value === undefined) next.delete(key);
      else next.set(key, value);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const [messageOpen, setMessageOpen] = useState(false);
  const [chatPrefs, setChatPrefs] = useState<ConversationPrefs>(DEFAULT_CONVERSATION_PREFS);
  const [exportPrefs, setExportPrefs] = useExportPrefs();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape' && fullScreen) {
        event.preventDefault();
        setParam('full', undefined);
        return;
      }
      if (event.key.toLowerCase() === 'f' && !isTypingTarget(event.target)) {
        event.preventDefault();
        setParam('full', fullScreen ? undefined : '1');
      }
    };
    // Bubble phase on purpose: an open modal stops the event first, so Esc
    // closes the dialog before it closes full screen.
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullScreen, setParam]);

  return (
    <Async resource={detail}>
      {(data) => {
        const ui = runStatusUi(data.run.status);
        const actions = availableRunActions(data.run.status);

        const runAction = async (action: RunAction) => {
          switch (action) {
            case 'start':
              return void act(() => client.startQueuedRun(runId), 'Run started');
            case 'pause':
              return void act(() => client.pauseRun(runId), 'Run paused');
            case 'resume':
              return void act(() => client.resumeRun(runId), 'Run resumed');
            case 'cancel':
              return void act(() => client.cancelRun(runId), 'Run cancelled');
            case 'retry':
              return void act(async () => {
                const retried = await client.retryRun(runId);
                navigate(`/runs/${retried.id}`);
              }, 'Retrying');
            default:
              return undefined;
          }
        };

        return (
          <>
            <div className="page-head">
              <div className="col" style={{ gap: 6, minWidth: 0 }}>
                <div className="row">
                  <Link className="btn btn-ghost btn-sm" to="/runs">
                    ← Runs
                  </Link>
                  <Link className="btn btn-ghost btn-sm" to={`/teams/${data.team.id}`}>
                    {data.team.name}
                  </Link>
                </div>
                <h1>{data.run.objective}</h1>
                <div className="row" style={{ gap: 8 }}>
                  <StatusPill status={ui} />
                  <span className="page-sub">
                    created {formatRelative(data.run.createdAt)}
                    {data.run.startedAt && ` · ran for ${formatDuration(runDurationMs(data.run))}`}
                  </span>
                  {data.isActive && <span className="tiny muted">live</span>}
                </div>
              </div>

              <div className="actions">
                <RunExportControls
                  runId={runId}
                  prefs={exportPrefs}
                  onPrefsChange={setExportPrefs}
                />
                <button type="button" className="btn" onClick={() => setMessageOpen(true)}>
                  Send message
                </button>
                <button
                  type="button"
                  className="btn"
                  title="Fill the window with this run (f)"
                  onClick={() => setParam('full', '1')}
                >
                  Full screen <span className="kbd">f</span>
                </button>
                <button
                  type="button"
                  className="btn"
                  aria-pressed={replaying}
                  onClick={() => setParam('replay', replaying ? undefined : '1')}
                >
                  {replaying ? 'Exit replay' : 'Replay'}
                </button>
                {actions.map((action) => (
                  <button
                    key={action}
                    type="button"
                    className={`btn${action === 'retry' || action === 'start' ? ' btn-primary' : ''}${
                      action === 'cancel' ? ' btn-danger' : ''
                    }`}
                    title={ACTION_LABEL[action]}
                    onClick={() => void runAction(action)}
                  >
                    {ACTION_LABEL[action]}
                  </button>
                ))}
                <button
                  type="button"
                  className="btn btn-ghost"
                  title={
                    data.isActive
                      ? 'Cancel the run before deleting it'
                      : 'Delete this run and everything under it'
                  }
                  disabled={data.isActive}
                  onClick={() => setParam('action', 'delete')}
                >
                  Delete
                </button>
              </div>
            </div>

            <div className="grid main-aside">
              <div className="col" style={{ gap: 20 }}>
                <Card title="Progress">
                  <div className="col" style={{ gap: 14 }}>
                    <TaskProgressSummary progress={data.progress} />
                    <RunTotals totals={data.run.totals} />
                    {data.run.summary && (
                      <div className="notice-box">
                        <strong>Summary</strong>
                        <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>
                          {data.run.summary}
                        </div>
                      </div>
                    )}
                    {data.run.error && <div className="error-box">{data.run.error}</div>}
                  </div>
                </Card>

                <PendingQuestions runId={runId} agents={data.agents} />

                <div className="tabs" role="tablist">
                  {(
                    [
                      ['conversation', 'Conversation'],
                      ['tasks', `Tasks (${data.tasks.length})`],
                      ['timeline', `Timeline (${data.events.length})`],
                    ] as Array<[Tab, string]>
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      className="tab"
                      aria-selected={tab === id}
                      onClick={() => setParam('tab', id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {tab === 'conversation' && (
                  <Card title="Conversation" flush>
                    <Conversation
                      data={data}
                      prefs={chatPrefs}
                      onPrefsChange={setChatPrefs}
                      live={data.isActive}
                    />
                  </Card>
                )}

                {tab === 'tasks' && (
                  <Card title="Task board">
                    <TaskBoard tasks={data.tasks} agents={data.agents} focusTaskId={focusTaskId} />
                  </Card>
                )}

                {tab === 'timeline' &&
                  (replaying ? (
                    <ReplayTimeline data={data} />
                  ) : (
                    <Card title="Timeline" flush>
                      <Timeline events={data.events} agents={data.agents} />
                    </Card>
                  ))}

              </div>

              <div className="col" style={{ gap: 20 }}>
                <Card title="Configuration used">
                  <p className="small muted" style={{ marginBottom: 10 }}>
                    Snapshot taken when the run started — this is exactly what each agent ran with.
                  </p>
                  <div className="col" style={{ gap: 8 }}>
                    {data.run.agentConfigSnapshot.map((snapshot) => {
                      const agent = data.agents.find((a) => a.id === snapshot.agentId);
                      return (
                        <div key={snapshot.agentId} className="agent-card">
                          {agent && <AgentAvatar agent={agent} />}
                          <span className="col" style={{ gap: 1, minWidth: 0 }}>
                            <span className="strong truncate">
                              {snapshot.handle}
                              {snapshot.isOrchestrator && (
                                <span className="tiny muted"> · orchestrator</span>
                              )}
                            </span>
                            <span className="tiny muted truncate">{snapshot.role}</span>
                          </span>
                          <span className="row right" style={{ gap: 5 }}>
                            <ModelBadge model={snapshot.model} />
                            <EffortBadge effort={snapshot.effort} />
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </Card>

                {data.questions.length > 0 && (
                  <Card title="Questions">
                    <p className="tiny muted" style={{ marginBottom: 10 }}>
                      What the agents asked you, and what they were told.
                    </p>
                    <div className="col" style={{ gap: 12 }}>
                      {data.questions.map((question) => (
                        <AnsweredQuestion
                          key={question.id}
                          question={question}
                          agents={data.agents}
                        />
                      ))}
                    </div>
                  </Card>
                )}

                {data.approvals.length > 0 && (
                  <Card title="Approvals">
                    <div className="col" style={{ gap: 8 }}>
                      {data.approvals.map((approval) => (
                        <div key={approval.id} className="col" style={{ gap: 2 }}>
                          <span className="small truncate">{approval.summary}</span>
                          <span className="tiny muted">
                            {approval.status}
                            {approval.decision ? ` · ${approval.decision}` : ''}
                            {approval.decidedBy ? ` · by ${approval.decidedBy}` : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}

                <Card title="Run details">
                  <div className="col small" style={{ gap: 8 }}>
                    <div className="spread">
                      <span className="muted">Run id</span>
                      <span className="mono">{data.run.id}</span>
                    </div>
                    <div className="spread">
                      <span className="muted">Workspace</span>
                      <span className="mono truncate">{data.run.workspace ?? '—'}</span>
                    </div>
                    <div className="spread">
                      <span className="muted">Budget cost cap</span>
                      <span>
                        {data.run.budget?.maxCostUsd ? formatUsd(data.run.budget.maxCostUsd) : '—'}
                      </span>
                    </div>
                    {data.run.retryOfRunId && (
                      <div className="spread">
                        <span className="muted">Retry of</span>
                        <Link to={`/runs/${data.run.retryOfRunId}`}>previous run</Link>
                      </div>
                    )}
                  </div>
                </Card>
              </div>
            </div>

            {messageOpen && (
              <SendMessageDialog
                runId={runId}
                agents={data.agents}
                onClose={() => setMessageOpen(false)}
              />
            )}

            {params.get('action') === 'delete' && (
              <DeleteRunDialog
                data={data}
                onClose={() => setParam('action', undefined)}
              />
            )}

            {fullScreen && (
              <FullScreenRun
                data={data}
                tab={fullTab}
                onTabChange={(next) => setParam('view', next)}
                onExit={() => setParam('full', undefined)}
                prefs={exportPrefs}
                onPrefsChange={setExportPrefs}
              />
            )}
          </>
        );
      }}
    </Async>
  );
}

/* ------------------------------------------------------------------ *
 * Questions
 * ------------------------------------------------------------------ */

const QUESTION_STATUS_TONE: Record<QuestionDto['status'], string> = {
  pending: 'tone-info',
  answered: 'tone-success',
  expired: 'tone-warning',
  skipped: 'tone-muted',
};

/**
 * Questions this run is currently parked on.
 *
 * The list comes from the questions centre rather than from the run payload, so
 * it only ever offers questions that are genuinely still answerable — and the
 * dialog it opens is the same one that interrupts from anywhere else.
 */
function PendingQuestions({ runId, agents }: { runId: string; agents: RunDetailDto['agents'] }) {
  const pending = useRunQuestions(runId);
  const { open } = useQuestions();

  if (pending.length === 0) return null;

  return (
    <Card
      className="tone-info question-spotlight"
      title={
        <div className="col" style={{ gap: 2 }}>
          <h2 style={{ fontSize: 15 }}>
            {pending.length === 1
              ? 'An agent is waiting on you'
              : `${pending.length} agents are waiting on you`}
          </h2>
          <span className="tiny muted">
            This is a decision, not a permission — the run cannot continue until you answer.
          </span>
        </div>
      }
    >
      <div className="col" style={{ gap: 10 }}>
        {pending.map((question) => (
          <div key={question.id} className="spread">
            <span className="col" style={{ gap: 2, minWidth: 0 }}>
              <span className="strong truncate">{question.header || 'Question'}</span>
              <span className="small muted truncate">{question.question}</span>
              <span className="tiny muted">
                asked by {agents.find((a) => a.id === question.agentId)?.handle ?? question.agentId}
                {question.options.length > 0 &&
                  ` · ${question.options.length} option${question.options.length === 1 ? '' : 's'}`}
              </span>
            </span>
            <button
              type="button"
              className="btn btn-primary right"
              onClick={() => open(question.id)}
            >
              Answer
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** One question in the run's history, with whatever answer it ended up with. */
function AnsweredQuestion({
  question,
  agents,
}: {
  question: QuestionDto;
  agents: RunDetailDto['agents'];
}) {
  return (
    <div
      className={`col question-record ${QUESTION_STATUS_TONE[question.status]}`}
      style={{ gap: 4 }}
    >
      <span className="small strong">{question.header || 'Question'}</span>
      <span className="small">{question.question}</span>
      {question.options.length > 0 && (
        <span className="tiny muted">
          offered: {question.options.map((option) => option.label).join(' · ')}
        </span>
      )}
      {question.answer ? (
        <span className="small question-answer">{question.answer}</span>
      ) : (
        <span className="tiny muted">no answer yet</span>
      )}
      <span className="tiny muted">
        {question.status}
        {question.answeredBy ? ` · by ${question.answeredBy}` : ''}
        {' · asked by '}
        {agents.find((a) => a.id === question.agentId)?.handle ?? question.agentId}
        {` · ${formatRelative(question.createdAt)}`}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Replay
 * ------------------------------------------------------------------ */

function ReplayTimeline({ data }: { data: RunDetailDto }) {
  const events = data.events;
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    if (!playing) return;
    timer.current = setInterval(() => {
      setCursor((current) => {
        if (current >= events.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 600 / speed);
    return () => clearInterval(timer.current);
  }, [playing, speed, events.length]);

  const shown = useMemo(() => events.slice(0, cursor + 1), [events, cursor]);
  const current = events[cursor];

  if (events.length === 0) return <EmptyState title="Nothing to replay" />;

  return (
    <Card
      title="Replay"
      actions={
        <>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setCursor(0);
              setPlaying(false);
            }}
          >
            ⏮
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setPlaying((p) => !p)}>
            {playing ? '⏸' : '▶'}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setCursor((c) => Math.min(events.length - 1, c + 1))}
          >
            ⏭
          </button>
          <select
            className="select btn-sm"
            style={{ width: 78 }}
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
          >
            <option value={0.5}>0.5×</option>
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={4}>4×</option>
          </select>
        </>
      }
      flush
    >
      <div className="card-body" style={{ paddingBottom: 8 }}>
        <input
          type="range"
          min={0}
          max={events.length - 1}
          value={cursor}
          style={{ width: '100%', accentColor: 'var(--accent)' }}
          onChange={(event) => {
            setPlaying(false);
            setCursor(Number(event.target.value));
          }}
          aria-label="Replay position"
        />
        <div className="row small muted">
          <span>
            event {cursor + 1} / {events.length}
          </span>
          <span className="right">{current ? formatRelative(current.createdAt) : ''}</span>
        </div>
      </div>
      <Timeline events={shown} agents={data.agents} highlightId={current?.id} />
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Message into the run
 * ------------------------------------------------------------------ */

/**
 * Deleting a run is the one action here that cannot be undone by another one:
 * cancel leaves the history, delete removes it. So it says exactly how much
 * history is about to go, and asks for the objective to be typed — the same
 * bar as deleting a team.
 */
function DeleteRunDialog({ data, onClose }: { data: RunDetailDto; onClose: () => void }) {
  const act = useAction();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState('');
  // Long objectives are unreasonable to retype; the first few words are enough
  // to prove you are looking at the right run.
  const phrase = data.run.objective.trim().split(/\s+/).slice(0, 4).join(' ');

  return (
    <Modal
      title="Delete run"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={confirm.trim() !== phrase}
            onClick={() =>
              void act(async () => {
                await client.deleteRun(data.run.id);
                onClose();
                navigate('/runs');
              }, 'Run deleted')
            }
          >
            Delete permanently
          </button>
        </>
      }
    >
      <p className="small">
        This removes the run and everything under it: {data.tasks.length} task(s),{' '}
        {data.messages.length} message(s), {data.events.length} timeline entries, and its
        approvals and questions. The team and its agents are untouched.
      </p>
      <p className="small">
        Type <strong>{phrase}</strong> to confirm.
      </p>
      <input
        className="input"
        autoFocus
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
      />
    </Modal>
  );
}

function SendMessageDialog({
  runId,
  agents,
  onClose,
}: {
  runId: string;
  agents: RunDetailDto['agents'];
  onClose: () => void;
}) {
  const act = useAction();
  const [to, setTo] = useState(agents[0]?.id ?? '');
  const [content, setContent] = useState('');

  return (
    <Modal
      title="Send a message into this run"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!to || !content.trim()}
            onClick={() =>
              void act(async () => {
                await client.sendMessage({ runId, from: 'user', to: [to], content });
                onClose();
              }, 'Message delivered')
            }
          >
            Send
          </button>
        </>
      }
    >
      <Field label="To">
        <select className="select" value={to} onChange={(event) => setTo(event.target.value)}>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.handle} — {agent.role}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Message">
        <textarea
          className="textarea"
          autoFocus
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
      </Field>
    </Modal>
  );
}
