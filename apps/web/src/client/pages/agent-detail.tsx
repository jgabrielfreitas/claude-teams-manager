import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { AgentEffort, ToolPermission } from '@claude-team/domain';
import type { AgentDto, AgentInspectionDto } from '@claude-team/protocol';
import { formatDuration } from '@claude-team/ui-shared';
import { client } from '../api';
import { AgentAvatar } from '../components/agent-views';
import { EffortSelect, ModelSelect, PermissionEditor, WorkspaceField } from '../components/pickers';
import { MessageThread, Timeline } from '../components/run-views';
import {
  Async,
  Card,
  EffortBadge,
  EmptyState,
  Field,
  Modal,
  ModelBadge,
  Stat,
  StatusPill,
} from '../components/ui';
import { useResource } from '../hooks/use-resource';
import { agentStatusUi } from '../lib/tone';
import { eventTouchesAgent } from '@claude-team/protocol';
import { useDeclareSelection } from '../state/selection';
import { useAction } from '../state/toasts';

type Tab = 'overview' | 'config' | 'permissions' | 'communication' | 'memory';

/** Which tab a command-palette action should land on. */
const TAB_FOR_ACTION: Record<string, Tab> = {
  edit: 'config',
  permissions: 'permissions',
  communication: 'communication',
};

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Inspector' },
  { id: 'config', label: 'Configuration' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'communication', label: 'Communication' },
  { id: 'memory', label: 'Context & memory' },
];

/**
 * The Agent Inspector.
 *
 * Everything shown here comes from `inspectAgent`; everything changed here goes
 * back through one core method. Model and effort are changed with the
 * first-class per-agent shortcuts, so no teammate is ever touched.
 */
export function AgentDetailPage() {
  const { agentId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  useDeclareSelection({ agentId });

  const inspection = useResource<AgentInspectionDto>(
    () => client.inspectAgent(agentId),
    [agentId],
    (event) => eventTouchesAgent(event, agentId) || event.type === 'run.event',
  );

  // Teammates, so messages and events render handles rather than raw ids.
  const teamId = inspection.data?.agent.teamId;
  const teammates = useResource<AgentDto[]>(
    () => (teamId ? client.listAgents(teamId) : Promise.resolve([])),
    [teamId],
    (event) => event.type === 'agent.changed' || event.type === 'agent.status',
  );

  const action = params.get('action') ?? undefined;
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => {
    if (action && TAB_FOR_ACTION[action]) setTab(TAB_FOR_ACTION[action]);
  }, [action]);

  const close = () => {
    params.delete('action');
    setParams(params, { replace: true });
  };

  return (
    <Async resource={inspection}>
      {(data) => {
        const agent = data.agent;
        return (
          <>
            <div className="page-head">
              <div className="col" style={{ gap: 6 }}>
                <div className="row">
                  <Link className="btn btn-ghost btn-sm" to={`/teams/${data.team.id}`}>
                    ← {data.team.name}
                  </Link>
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <AgentAvatar agent={agent} />
                  <div className="col" style={{ gap: 2 }}>
                    <h1>
                      {agent.handle}
                      <span className="muted" style={{ fontWeight: 400 }}>
                        {' '}
                        · {agent.name}
                      </span>
                    </h1>
                    <div className="row" style={{ gap: 6 }}>
                      <span className="page-sub">{agent.role}</span>
                      <StatusPill status={agentStatusUi(agent.status)} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setParams({ action: 'message' })}
                >
                  Message
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setParams({ action: 'duplicate' })}
                >
                  Duplicate
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => setParams({ action: 'delete' })}
                >
                  Delete
                </button>
              </div>
            </div>

            <div className="grid cols-4">
              <Stat label="Model" value={<ModelBadge model={agent.model} />} />
              <Stat label="Effort" value={<EffortBadge effort={agent.effort} />} />
              <Stat label="Activations" value={data.activations} hint={`${data.toolCalls} tool calls`} />
              <Stat
                label="Runtime"
                value={formatDuration(data.runtimeMs)}
                hint={`${data.messageCount} messages · ${data.unreadCount} unread`}
              />
            </div>

            <Card title="Model and effort — this agent only">
              <div className="form-grid">
                <Field label="Model">
                  <QuickModel agent={agent} onSaved={inspection.reload} />
                </Field>
                <Field label="Effort">
                  <QuickEffort agent={agent} onSaved={inspection.reload} />
                </Field>
              </div>
            </Card>

            <div className="tabs" role="tablist">
              {TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  className="tab"
                  aria-selected={tab === entry.id}
                  onClick={() => setTab(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </div>

            {tab === 'overview' && (
              <Overview data={data} teammates={teammates.data ?? [data.agent]} />
            )}
            {tab === 'config' && <ConfigTab agent={agent} onSaved={inspection.reload} />}
            {tab === 'permissions' && <PermissionsTab agent={agent} onSaved={inspection.reload} />}
            {tab === 'communication' && (
              <CommunicationTab agent={agent} reachable={data.reachable} onSaved={inspection.reload} />
            )}
            {tab === 'memory' && <MemoryTab agent={agent} onSaved={inspection.reload} />}

            {action === 'message' && <MessageDialog agent={agent} onClose={close} />}
            {action === 'duplicate' && <DuplicateDialog agent={agent} onClose={close} />}
            {action === 'delete' && (
              <DeleteDialog agent={agent} teamId={data.team.id} onClose={close} />
            )}
            {action === 'model' && (
              <Modal title="Switch model" onClose={close}>
                <p className="small muted">Applies to {agent.handle} only.</p>
                <QuickModel agent={agent} onSaved={inspection.reload} />
              </Modal>
            )}
            {action === 'effort' && (
              <Modal title="Change effort" onClose={close}>
                <p className="small muted">Applies to {agent.handle} only.</p>
                <QuickEffort agent={agent} onSaved={inspection.reload} />
              </Modal>
            )}
          </>
        );
      }}
    </Async>
  );
}

/* ------------------------------------------------------------------ *
 * Inspector
 * ------------------------------------------------------------------ */

function Overview({ data, teammates }: { data: AgentInspectionDto; teammates: AgentDto[] }) {
  return (
    <div className="grid main-aside">
      <div className="col" style={{ gap: 20 }}>
        <Card title="Recent events" flush>
          <Timeline
            events={[...data.lastEvents].reverse()}
            agents={teammates}
            emptyLabel="This agent has not run yet."
          />
        </Card>

        <Card title={`Inbox (${data.inbox.length})`} flush>
          <MessageThread messages={data.inbox} agents={teammates} />
        </Card>
      </div>

      <div className="col" style={{ gap: 20 }}>
        <Card title="Current task">
          {data.currentTask ? (
            <div className="col" style={{ gap: 6 }}>
              <span className="strong">{data.currentTask.title}</span>
              <span className="small muted">{data.currentTask.description}</span>
              <Link className="btn btn-sm" to={`/runs/${data.currentTask.runId}?tab=tasks`}>
                Open run
              </Link>
            </div>
          ) : (
            <span className="muted small">Not working on anything right now.</span>
          )}
        </Card>

        <Card title="Can message">
          {data.reachable.length === 0 ? (
            <span className="muted small">Nobody — this agent works alone.</span>
          ) : (
            <div className="row">
              {data.reachable.map((handle) => (
                <span key={handle} className="badge">
                  {handle}
                </span>
              ))}
            </div>
          )}
        </Card>

        <Card title="System prompt">
          <pre className="yaml" style={{ maxHeight: 320 }}>
            {data.agent.systemPrompt || '(empty)'}
          </pre>
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Per-agent shortcuts
 * ------------------------------------------------------------------ */

function QuickModel({ agent, onSaved }: { agent: AgentDto; onSaved: () => void }) {
  const act = useAction();
  return (
    <ModelSelect
      value={agent.model}
      onChange={(model) =>
        void act(async () => {
          await client.updateAgentModel(agent.id, model);
          onSaved();
        }, `${agent.handle} now runs on ${model}`)
      }
    />
  );
}

function QuickEffort({ agent, onSaved }: { agent: AgentDto; onSaved: () => void }) {
  const act = useAction();
  return (
    <EffortSelect
      value={agent.effort}
      onChange={(effort) =>
        void act(async () => {
          await client.updateAgentEffort(agent.id, effort);
          onSaved();
        }, `${agent.handle} effort set to ${effort}`)
      }
    />
  );
}

/* ------------------------------------------------------------------ *
 * Editing
 * ------------------------------------------------------------------ */

function ConfigTab({ agent, onSaved }: { agent: AgentDto; onSaved: () => void }) {
  const act = useAction();
  const [form, setForm] = useState({
    name: agent.name,
    handle: agent.handle,
    role: agent.role,
    description: agent.description ?? '',
    systemPrompt: agent.systemPrompt,
    workspace: agent.workspace ?? '',
    model: agent.model,
    effort: agent.effort,
    maxTurns: agent.limits.maxTurns ?? '',
    timeoutMs: agent.limits.timeoutMs ?? '',
    maxMessages: agent.limits.maxMessages ?? '',
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm((current) => ({ ...current, model: agent.model, effort: agent.effort }));
  }, [agent.model, agent.effort]);

  const save = async () => {
    setBusy(true);
    await act(async () => {
      await client.updateAgent(agent.id, {
        name: form.name,
        handle: form.handle,
        role: form.role,
        description: form.description || null,
        systemPrompt: form.systemPrompt,
        model: form.model,
        effort: form.effort,
        workspace: form.workspace || null,
        limits: {
          maxTurns: form.maxTurns === '' ? undefined : Number(form.maxTurns),
          timeoutMs: form.timeoutMs === '' ? undefined : Number(form.timeoutMs),
          maxMessages: form.maxMessages === '' ? undefined : Number(form.maxMessages),
        },
      });
      onSaved();
    }, 'Agent updated');
    setBusy(false);
  };

  return (
    <Card
      title="Configuration"
      actions={
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save()}>
          Save changes
        </button>
      }
    >
      <div className="col" style={{ gap: 16 }}>
        <div className="form-grid">
          <Field label="Name">
            <input
              className="input"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label="Handle" hint="Teammates address this agent by its handle.">
            <input
              className="input"
              value={form.handle}
              onChange={(event) => setForm({ ...form, handle: event.target.value })}
            />
          </Field>
          <Field label="Role">
            <input
              className="input"
              value={form.role}
              onChange={(event) => setForm({ ...form, role: event.target.value })}
            />
          </Field>
        </div>

        <Field label="Description">
          <input
            className="input"
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
        </Field>

        <div className="form-grid">
          <Field label="Model" hint="Per agent — teammates keep theirs.">
            <ModelSelect
              value={form.model}
              onChange={(model) => setForm({ ...form, model })}
            />
          </Field>
          <Field label="Effort" hint="Per agent — teammates keep theirs.">
            <EffortSelect
              value={form.effort}
              onChange={(effort: AgentEffort) => setForm({ ...form, effort })}
            />
          </Field>
        </div>

        <Field label="System prompt" hint="The persona and standing instructions for this agent.">
          <textarea
            className="textarea"
            style={{ minHeight: 260 }}
            value={form.systemPrompt}
            onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })}
          />
        </Field>

        <WorkspaceField
          value={form.workspace}
          onChange={(workspace) => setForm({ ...form, workspace })}
          hint="Overrides the team workspace for this agent."
        />

        <span className="label">Limits</span>
        <div className="form-grid">
          <Field label="Max turns" hint="Provider turns per activation.">
            <input
              className="input"
              type="number"
              min={1}
              value={form.maxTurns}
              onChange={(event) => setForm({ ...form, maxTurns: event.target.value })}
            />
          </Field>
          <Field label="Timeout (ms)">
            <input
              className="input"
              type="number"
              min={1000}
              value={form.timeoutMs}
              onChange={(event) => setForm({ ...form, timeoutMs: event.target.value })}
            />
          </Field>
          <Field label="Max messages">
            <input
              className="input"
              type="number"
              min={1}
              value={form.maxMessages}
              onChange={(event) => setForm({ ...form, maxMessages: event.target.value })}
            />
          </Field>
        </div>
      </div>
    </Card>
  );
}

function PermissionsTab({ agent, onSaved }: { agent: AgentDto; onSaved: () => void }) {
  const act = useAction();
  const [tools, setTools] = useState<ToolPermission[]>(agent.tools);
  const dirty = JSON.stringify(tools) !== JSON.stringify(agent.tools);

  return (
    <Card
      title="Tool permissions"
      actions={
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!dirty}
          onClick={() =>
            void act(async () => {
              await client.updateAgent(agent.id, { tools });
              onSaved();
            }, 'Permissions updated')
          }
        >
          Save permissions
        </button>
      }
    >
      <p className="small muted">
        <strong>Allow</strong> runs without asking, <strong>ask</strong> raises an approval you must
        answer, <strong>deny</strong> removes the capability entirely.
      </p>
      <PermissionEditor value={tools} onChange={setTools} />
    </Card>
  );
}

function CommunicationTab({
  agent,
  reachable,
  onSaved,
}: {
  agent: AgentDto;
  reachable: string[];
  onSaved: () => void;
}) {
  const act = useAction();
  const teammates = useResource<AgentDto[]>(
    () => client.listAgents(agent.teamId),
    [agent.teamId],
    (event) => event.type === 'agent.changed',
  );
  const [canMessage, setCanMessage] = useState<string[]>(agent.canMessage);
  const [rules, setRules] = useState(agent.communicationRules);

  const everyone = canMessage.includes('*');
  const handles = useMemo(
    () => (teammates.data ?? []).filter((a) => a.id !== agent.id).map((a) => a.handle),
    [teammates.data, agent.id],
  );

  const toggle = (handle: string) =>
    setCanMessage((current) =>
      current.includes(handle) ? current.filter((h) => h !== handle) : [...current, handle],
    );

  return (
    <Card
      title="Communication"
      actions={
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() =>
            void act(async () => {
              await client.updateAgent(agent.id, { canMessage, communicationRules: rules });
              onSaved();
            }, 'Communication updated')
          }
        >
          Save
        </button>
      }
    >
      <div className="col" style={{ gap: 16 }}>
        <div className="col" style={{ gap: 8 }}>
          <span className="label">Who this agent may message</span>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={everyone}
              onChange={(event) => setCanMessage(event.target.checked ? ['*'] : [])}
            />
            <span>
              <strong>Everyone on the team</strong>
              <span className="hint"> — the roster stays correct as teammates come and go.</span>
            </span>
          </label>

          {!everyone && (
            <div className="col" style={{ gap: 2 }}>
              {handles.length === 0 && <span className="muted small">No teammates yet.</span>}
              {handles.map((handle) => (
                <label key={handle} className="checkbox">
                  <input
                    type="checkbox"
                    checked={canMessage.includes(handle)}
                    onChange={() => toggle(handle)}
                  />
                  <span>{handle}</span>
                </label>
              ))}
            </div>
          )}

          <span className="hint">
            Currently reachable: {reachable.length > 0 ? reachable.join(', ') : 'nobody'}
          </span>
        </div>

        <Field label="Communication rules" hint="Injected into this agent's system prompt.">
          <textarea
            className="textarea"
            value={rules}
            onChange={(event) => setRules(event.target.value)}
          />
        </Field>
      </div>
    </Card>
  );
}

function MemoryTab({ agent, onSaved }: { agent: AgentDto; onSaved: () => void }) {
  const act = useAction();
  const [context, setContext] = useState(agent.context);
  const [memoryEnabled, setMemoryEnabled] = useState(agent.memory.enabled);
  const [notes, setNotes] = useState(agent.memory.notes);

  return (
    <Card
      title="Context & memory"
      actions={
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() =>
            void act(async () => {
              await client.updateAgent(agent.id, {
                context,
                memory: { enabled: memoryEnabled, notes },
              });
              onSaved();
            }, 'Context updated')
          }
        >
          Save
        </button>
      }
    >
      <div className="col" style={{ gap: 16 }}>
        <Field label="Static context" hint="Injected into every activation of this agent.">
          <textarea
            className="textarea"
            value={context}
            onChange={(event) => setContext(event.target.value)}
          />
        </Field>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={memoryEnabled}
            onChange={(event) => setMemoryEnabled(event.target.checked)}
          />
          <span>
            <strong>Enable memory</strong>
            <span className="hint"> — the agent can save durable notes between runs.</span>
          </span>
        </label>

        <Field label="Memory notes">
          <textarea
            className="textarea"
            value={notes}
            disabled={!memoryEnabled}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Dialogs
 * ------------------------------------------------------------------ */

function MessageDialog({ agent, onClose }: { agent: AgentDto; onClose: () => void }) {
  const act = useAction();
  const runs = useResource(() => client.listRuns(agent.teamId), [agent.teamId]);
  const [runId, setRunId] = useState('');
  const [content, setContent] = useState('');

  useEffect(() => {
    if (!runId && runs.data?.[0]) setRunId(runs.data[0].id);
  }, [runs.data, runId]);

  return (
    <Modal
      title={`Message ${agent.handle}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!runId || !content.trim()}
            onClick={() =>
              void act(async () => {
                await client.sendMessage({
                  runId,
                  from: 'user',
                  to: [agent.id],
                  content,
                  type: 'message',
                });
                onClose();
              }, 'Message delivered')
            }
          >
            Send
          </button>
        </>
      }
    >
      {runs.data && runs.data.length === 0 ? (
        <EmptyState
          title="No run to write into"
          description="Messages belong to a run. Start one from the team first."
        />
      ) : (
        <>
          <Field label="Run">
            <select
              className="select"
              value={runId}
              onChange={(event) => setRunId(event.target.value)}
            >
              {(runs.data ?? []).map((run) => (
                <option key={run.id} value={run.id}>
                  {run.status} · {run.objective.slice(0, 60)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Message">
            <textarea
              className="textarea"
              value={content}
              autoFocus
              onChange={(event) => setContent(event.target.value)}
            />
          </Field>
        </>
      )}
    </Modal>
  );
}

function DuplicateDialog({ agent, onClose }: { agent: AgentDto; onClose: () => void }) {
  const act = useAction();
  const navigate = useNavigate();
  const [name, setName] = useState(`${agent.name} (copy)`);
  const [handle, setHandle] = useState(`${agent.handle}-copy`);

  return (
    <Modal
      title="Duplicate agent"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              void act(async () => {
                const copy = await client.duplicateAgent(agent.id, { name, handle });
                onClose();
                navigate(`/agents/${copy.id}`);
              }, 'Agent duplicated')
            }
          >
            Duplicate
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name">
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Handle">
          <input
            className="input"
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
          />
        </Field>
      </div>
      <p className="small muted">
        The copy keeps the prompt, model ({agent.model}), effort ({agent.effort}) and permissions.
      </p>
    </Modal>
  );
}

function DeleteDialog({
  agent,
  teamId,
  onClose,
}: {
  agent: AgentDto;
  teamId: string;
  onClose: () => void;
}) {
  const act = useAction();
  const navigate = useNavigate();

  return (
    <Modal
      title={`Delete ${agent.handle}?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() =>
              void act(async () => {
                await client.deleteAgent(agent.id);
                onClose();
                navigate(`/teams/${teamId}`);
              }, 'Agent deleted')
            }
          >
            Delete agent
          </button>
        </>
      }
    >
      <p className="small">
        Teammates that could message <strong>{agent.handle}</strong> will have it removed from their
        routing lists.
      </p>
    </Modal>
  );
}
