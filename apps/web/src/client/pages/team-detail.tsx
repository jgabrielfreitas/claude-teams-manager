import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  DEFAULT_BUDGET,
  budgetProblem,
  describeBudget,
  isUnmetered,
  type AgentEffort,
  type Budget,
} from '@claude-team/domain';
import type { TeamWithAgentsDto } from '@claude-team/protocol';
import { formatRelative, truncate } from '@claude-team/ui-shared';
import { client } from '../api';
import { AgentCard } from '../components/agent-views';
import { BudgetFields, EffortSelect, ModelSelect, WorkspaceField } from '../components/pickers';
import { Async, Card, EmptyState, Field, Modal, StatusPill } from '../components/ui';
import { useResource } from '../hooks/use-resource';
import { runStatusUi } from '../lib/tone';
import { useCatalog } from '../state/catalog';
import { useDeclareSelection } from '../state/selection';
import { useAction, useToasts } from '../state/toasts';

/** A single team: roster, workspace, orchestrator, runs, and every edit path. */
export function TeamDetailPage() {
  const { teamId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  useDeclareSelection({ teamId });

  const team = useResource<TeamWithAgentsDto>(
    () => client.getTeam(teamId),
    [teamId],
    (event) =>
      (event.type === 'team.changed' && event.teamId === teamId) ||
      (event.type === 'agent.changed' && event.teamId === teamId) ||
      event.type === 'agent.status',
  );

  const runs = useResource(
    () => client.listRuns(teamId),
    [teamId],
    (event) => event.type === 'run.created' || event.type === 'run.status',
  );

  const workspace = useResource(
    () => (team.data?.workspace ? client.inspectWorkspace(team.data.workspace) : Promise.resolve(undefined)),
    [team.data?.workspace],
  );

  const dialog = params.get('action') ?? params.get('new') ?? undefined;
  const close = () => {
    params.delete('action');
    params.delete('new');
    setParams(params, { replace: true });
  };
  const open = (value: string, key: 'action' | 'new' = 'action') => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };

  return (
    <Async resource={team}>
      {(data) => (
        <>
          <div className="page-head">
            <div className="col" style={{ gap: 4 }}>
              <div className="row">
                <Link className="btn btn-ghost btn-sm" to="/teams">
                  ← Teams
                </Link>
              </div>
              <h1>{data.name}</h1>
              <div className="page-sub">{data.description ?? 'No description.'}</div>
            </div>
            <div className="actions">
              <button type="button" className="btn" onClick={() => open('export')}>
                Export
              </button>
              <button type="button" className="btn" onClick={() => open('edit')}>
                Edit
              </button>
              <button type="button" className="btn btn-primary" onClick={() => open('run')}>
                Start run
              </button>
            </div>
          </div>

          <div className="grid main-aside">
            <div className="col" style={{ gap: 20 }}>
              <Card
                title={`Agents (${data.agents.length})`}
                actions={
                  <>
                    <button type="button" className="btn btn-sm" onClick={() => open('template', 'new')}>
                      From template
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => open('agent', 'new')}>
                      Blank agent
                    </button>
                  </>
                }
              >
                {data.agents.length === 0 ? (
                  <EmptyState
                    title="This team has no agents"
                    description="Add one from a template — you can change its model, effort, prompt and permissions afterwards."
                    action={
                      <button type="button" className="btn btn-primary" onClick={() => open('template', 'new')}>
                        Add from template
                      </button>
                    }
                  />
                ) : (
                  <div className="col" style={{ gap: 8 }}>
                    {data.agents.map((agent) => (
                      <AgentCard
                        key={agent.id}
                        agent={agent}
                        subtitle={agent.id === data.orchestratorId ? 'orchestrator' : undefined}
                      />
                    ))}
                  </div>
                )}
              </Card>

              <Card
                title="Runs"
                actions={
                  <Link className="btn btn-sm btn-ghost" to="/runs">
                    All runs
                  </Link>
                }
                flush
              >
                <Async resource={runs}>
                  {(list) =>
                    list.length === 0 ? (
                      <EmptyState title="No runs for this team yet" />
                    ) : (
                      <div className="list">
                        {list.slice(0, 12).map((run) => (
                          <Link key={run.id} className="list-item" to={`/runs/${run.id}`}>
                            <StatusPill status={runStatusUi(run.status)} />
                            <span className="truncate">{truncate(run.objective, 80)}</span>
                            <span className="tiny muted right nowrap">
                              {formatRelative(run.createdAt)}
                            </span>
                          </Link>
                        ))}
                      </div>
                    )
                  }
                </Async>
              </Card>
            </div>

            <div className="col" style={{ gap: 20 }}>
              <Card title="Configuration">
                <dl className="col" style={{ gap: 10, margin: 0 }}>
                  <Row label="Orchestrator">
                    {data.orchestratorId ? (
                      <Link to={`/agents/${data.orchestratorId}`}>
                        {data.agents.find((a) => a.id === data.orchestratorId)?.handle ?? '—'}
                      </Link>
                    ) : (
                      <span className="muted">none</span>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => open('orchestrator')}
                    >
                      Change
                    </button>
                  </Row>
                  <Row label="Workspace">
                    <span className="mono small truncate">{data.workspace ?? 'not set'}</span>
                  </Row>
                  {workspace.data && (
                    <Row label="Git">
                      <span className="small muted">
                        {workspace.data.summary ??
                          (workspace.data.exists ? 'not a repository' : 'path does not exist')}
                      </span>
                    </Row>
                  )}
                  <Row label="Budget">
                    <span
                      className={`small ${isUnmetered(data.budget) ? 'tone-text tone-warning' : 'muted'}`}
                    >
                      {describeBudget(data.budget)}
                    </span>
                  </Row>
                  <Row label="Created">
                    <span className="small muted">{formatRelative(data.createdAt)}</span>
                  </Row>
                </dl>
              </Card>

              <Card title="Danger zone">
                <div className="col" style={{ gap: 8 }}>
                  <button type="button" className="btn btn-block" onClick={() => open('duplicate')}>
                    Duplicate team
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-block"
                    onClick={() => open('delete')}
                  >
                    Delete team
                  </button>
                </div>
              </Card>
            </div>
          </div>

          {dialog === 'edit' && <EditTeamDialog team={data} onClose={close} onSaved={team.reload} />}
          {dialog === 'export' && <ExportDialog teamId={data.id} onClose={close} />}
          {dialog === 'orchestrator' && (
            <OrchestratorDialog team={data} onClose={close} onSaved={team.reload} />
          )}
          {dialog === 'delete' && <DeleteTeamDialog team={data} onClose={close} />}
          {dialog === 'duplicate' && <DuplicateTeamDialog team={data} onClose={close} />}
          {dialog === 'run' && <StartRunDialog team={data} onClose={close} />}
          {dialog === 'agent' && <NewAgentDialog team={data} onClose={close} onSaved={team.reload} />}
          {dialog === 'template' && (
            <TemplateDialog team={data} onClose={close} onSaved={team.reload} />
          )}
        </>
      )}
    </Async>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="spread">
      <dt className="label">{label}</dt>
      <dd className="row" style={{ margin: 0, gap: 6, minWidth: 0 }}>
        {children}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Dialogs
 * ------------------------------------------------------------------ */

function EditTeamDialog({
  team,
  onClose,
  onSaved,
}: {
  team: TeamWithAgentsDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const act = useAction();
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? '');
  const [workspace, setWorkspace] = useState(team.workspace ?? '');
  const [budget, setBudget] = useState<Budget>(team.budget ?? { ...DEFAULT_BUDGET });
  const [busy, setBusy] = useState(false);
  const budgetIssue = budgetProblem(budget);

  const save = async () => {
    setBusy(true);
    await act(async () => {
      await client.updateTeam(team.id, {
        name,
        description: description || null,
        workspace: workspace || null,
        budget,
      });
      onSaved();
      onClose();
    }, 'Team updated');
    setBusy(false);
  };

  return (
    <Modal
      title="Edit team"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || Boolean(budgetIssue)}
            onClick={() => void save()}
          >
            Save
          </button>
        </>
      }
    >
      <Field label="Name">
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Description">
        <input
          className="input"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <WorkspaceField value={workspace} onChange={setWorkspace} />

      <span className="label">Budget</span>
      <BudgetFields budget={budget} onChange={setBudget} idPrefix="team-budget" />
    </Modal>
  );
}

function ExportDialog({ teamId, onClose }: { teamId: string; onClose: () => void }) {
  const { notify, fail } = useToasts();
  const [yaml, setYaml] = useState<string | undefined>();

  useEffect(() => {
    void client
      .exportTeam(teamId)
      .then((result) => setYaml(result.yaml))
      .catch(fail);
  }, [teamId, fail]);

  const copy = async () => {
    if (!yaml) return;
    try {
      await navigator.clipboard.writeText(yaml);
      notify('YAML copied to your clipboard', 'success');
    } catch {
      notify('Could not copy — select the text and copy manually.', 'warning');
    }
  };

  return (
    <Modal
      wide
      title="Export team"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn-primary" disabled={!yaml} onClick={() => void copy()}>
            Copy YAML
          </button>
        </>
      }
    >
      <p className="small muted">
        This is the whole team — every agent, its model, effort, prompt and permissions. Paste it
        into another instance to recreate the team exactly.
      </p>
      <pre className="yaml">{yaml ?? 'Loading…'}</pre>
    </Modal>
  );
}

function OrchestratorDialog({
  team,
  onClose,
  onSaved,
}: {
  team: TeamWithAgentsDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const act = useAction();
  const [selected, setSelected] = useState(team.orchestratorId ?? team.agents[0]?.id ?? '');
  const [alsoDefault, setAlsoDefault] = useState(team.defaultAgentId === team.orchestratorId);

  const save = async () => {
    await act(async () => {
      await client.updateTeam(team.id, {
        orchestratorId: selected,
        ...(alsoDefault ? { defaultAgentId: selected } : {}),
      });
      onSaved();
      onClose();
    }, 'Orchestrator updated');
  };

  return (
    <Modal
      title="Select orchestrator"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <p className="small muted">
        The orchestrator plans the run, creates tasks and delegates them. It is the only agent that
        gets the orchestration tools.
      </p>
      <div className="col" style={{ gap: 8 }}>
        {team.agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className="choice"
            aria-pressed={selected === agent.id}
            onClick={() => setSelected(agent.id)}
          >
            <span className="col" style={{ gap: 2 }}>
              <span className="strong">{agent.handle}</span>
              <span className="tiny muted">
                {agent.role} · {agent.model}/{agent.effort}
              </span>
            </span>
          </button>
        ))}
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={alsoDefault}
          onChange={(event) => setAlsoDefault(event.target.checked)}
        />
        <span className="small">Also make it the default agent for direct messages</span>
      </label>
    </Modal>
  );
}

function DeleteTeamDialog({ team, onClose }: { team: TeamWithAgentsDto; onClose: () => void }) {
  const act = useAction();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState('');

  return (
    <Modal
      title="Delete team"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={confirm !== team.name}
            onClick={() =>
              void act(async () => {
                await client.deleteTeam(team.id);
                onClose();
                navigate('/teams');
              }, 'Team deleted')
            }
          >
            Delete permanently
          </button>
        </>
      }
    >
      <p className="small">
        This deletes the team, its {team.agents.length} agents and their run history. Type{' '}
        <strong>{team.name}</strong> to confirm.
      </p>
      <input className="input" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
    </Modal>
  );
}

function DuplicateTeamDialog({ team, onClose }: { team: TeamWithAgentsDto; onClose: () => void }) {
  const act = useAction();
  const navigate = useNavigate();
  const [name, setName] = useState(`${team.name} (copy)`);

  return (
    <Modal
      title="Duplicate team"
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
                const copy = await client.duplicateTeam(team.id, name);
                onClose();
                navigate(`/teams/${copy.id}`);
              }, 'Team duplicated')
            }
          >
            Duplicate
          </button>
        </>
      }
    >
      <Field label="Name of the copy">
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <p className="small muted">
        Every agent is copied with its own model, effort, prompt and permissions.
      </p>
    </Modal>
  );
}

export function StartRunDialog({ team, onClose }: { team: TeamWithAgentsDto; onClose: () => void }) {
  const act = useAction();
  const navigate = useNavigate();
  const [objective, setObjective] = useState('');
  const [workspace, setWorkspace] = useState(team.workspace ?? '');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    await act(async () => {
      const run = await client.startRun({
        teamId: team.id,
        objective,
        workspace: workspace || undefined,
      });
      onClose();
      navigate(`/runs/${run.id}`);
    }, 'Run started');
    setBusy(false);
  };

  return (
    <Modal
      title={`Start a run · ${team.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !objective.trim()}
            onClick={() => void start()}
          >
            Start run
          </button>
        </>
      }
    >
      <Field
        label="Objective"
        hint="One clear outcome. The orchestrator turns it into a task graph."
      >
        <textarea
          className="textarea"
          value={objective}
          autoFocus
          onChange={(event) => setObjective(event.target.value)}
          placeholder="Add refresh-token rotation to the auth service and cover it with tests."
        />
      </Field>
      <WorkspaceField value={workspace} onChange={setWorkspace} hint="Defaults to the team workspace." />
      <div className="notice-box small">
        Running with:{' '}
        {team.agents.map((agent) => `${agent.handle} (${agent.model}/${agent.effort})`).join(', ')}
      </div>
    </Modal>
  );
}

function NewAgentDialog({
  team,
  onClose,
  onSaved,
}: {
  team: TeamWithAgentsDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const act = useAction();
  const navigate = useNavigate();
  const { settings } = useCatalog();
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [handle, setHandle] = useState('');
  const [model, setModel] = useState(settings.defaultModel);
  const [effort, setEffort] = useState<AgentEffort>(settings.defaultEffort);
  const [systemPrompt, setSystemPrompt] = useState('');

  return (
    <Modal
      title="New agent"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!name.trim() || !role.trim()}
            onClick={() =>
              void act(async () => {
                const agent = await client.createAgent({
                  teamId: team.id,
                  name,
                  role,
                  handle: handle || undefined,
                  model,
                  effort,
                  systemPrompt: systemPrompt || undefined,
                });
                onSaved();
                onClose();
                navigate(`/agents/${agent.id}`);
              }, 'Agent created')
            }
          >
            Create agent
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name">
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Role">
          <input
            className="input"
            value={role}
            placeholder="Backend Engineer"
            onChange={(event) => setRole(event.target.value)}
          />
        </Field>
        <Field label="Handle" hint="Optional — derived from the name when empty.">
          <input
            className="input"
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
          />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="Model" hint="This agent only.">
          <ModelSelect value={model} onChange={setModel} />
        </Field>
        <Field label="Effort" hint="This agent only.">
          <EffortSelect value={effort} onChange={setEffort} />
        </Field>
      </div>
      <Field label="System prompt" hint="Optional. You can write it now or later.">
        <textarea
          className="textarea"
          value={systemPrompt}
          onChange={(event) => setSystemPrompt(event.target.value)}
        />
      </Field>
    </Modal>
  );
}

function TemplateDialog({
  team,
  onClose,
  onSaved,
}: {
  team: TeamWithAgentsDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const act = useAction();
  const navigate = useNavigate();
  const { catalog, settings } = useCatalog();
  const [templateId, setTemplateId] = useState(catalog.templates[0]?.id ?? '');
  const template = catalog.templates.find((t) => t.id === templateId);
  // The template carries its own model and effort; with no template at all the
  // fallback is the configured default, never a literal.
  const [model, setModel] = useState(template?.model ?? settings.defaultModel);
  const [effort, setEffort] = useState<AgentEffort>(template?.effort ?? settings.defaultEffort);

  const select = (id: string) => {
    const next = catalog.templates.find((t) => t.id === id);
    setTemplateId(id);
    if (next) {
      setModel(next.model);
      setEffort(next.effort);
    }
  };

  return (
    <Modal
      wide
      title="Add agent from template"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!templateId}
            onClick={() =>
              void act(async () => {
                const agent = await client.createAgentFromTemplate({
                  teamId: team.id,
                  templateId,
                  model,
                  effort,
                });
                onSaved();
                onClose();
                navigate(`/agents/${agent.id}`);
              }, 'Agent added')
            }
          >
            Add agent
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 8, maxHeight: 320, overflowY: 'auto' }}>
        {catalog.templates.map((option) => (
          <button
            key={option.id}
            type="button"
            className="choice"
            aria-pressed={option.id === templateId}
            onClick={() => select(option.id)}
          >
            <span className="col" style={{ gap: 2 }}>
              <span className="strong">
                {option.name}
                {option.orchestratorCapable && (
                  <span className="tiny muted"> · can orchestrate</span>
                )}
              </span>
              <span className="small muted">{option.description}</span>
            </span>
            <span className="badge right">{option.category}</span>
          </button>
        ))}
      </div>

      <div className="form-grid">
        <Field label="Model" hint="Starts from the template; change it for this agent only.">
          <ModelSelect value={model} onChange={setModel} />
        </Field>
        <Field label="Effort">
          <EffortSelect value={effort} onChange={setEffort} />
        </Field>
      </div>
    </Modal>
  );
}
