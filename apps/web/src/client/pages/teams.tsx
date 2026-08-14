import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { AgentEffort } from '@claude-team/domain';
import type { TeamWithAgentsDto } from '@claude-team/protocol';
import { formatRelative, truncate } from '@claude-team/ui-shared';
import { client } from '../api';
import { AgentAvatar } from '../components/agent-views';
import { EffortSelect, ModelSelect, WorkspaceField } from '../components/pickers';
import { Async, Card, EmptyState, Field, Modal } from '../components/ui';
import { useResource } from '../hooks/use-resource';
import { useCatalog } from '../state/catalog';
import { useAction } from '../state/toasts';

/**
 * Teams: the list, plus the three ways a team comes into existence — blank,
 * from a preset (with per-agent model and effort), or imported from YAML.
 */
export function TeamsPage() {
  const [params, setParams] = useSearchParams();
  const teams = useResource<TeamWithAgentsDto[]>(
    () => client.listTeams(),
    [],
    (event) => event.type === 'team.changed' || event.type === 'agent.changed',
  );

  const dialog = params.get('new') ?? params.get('action') ?? undefined;
  const close = () => {
    params.delete('new');
    params.delete('action');
    setParams(params, { replace: true });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Teams</h1>
          <div className="page-sub">
            A team is a roster of agents, each with its own model, effort and permissions.
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={() => setParams({ action: 'import' })}>
            Import YAML
          </button>
          <button type="button" className="btn" onClick={() => setParams({ new: 'blank' })}>
            Blank team
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setParams({ new: 'preset' })}>
            New from preset
          </button>
        </div>
      </div>

      <Async resource={teams}>
        {(list) =>
          list.length === 0 ? (
            <Card>
              <EmptyState
                title="No teams yet"
                description="A preset gives you a working team — an orchestrator plus specialists, each already tuned to a sensible model and effort."
                action={
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => setParams({ new: 'preset' })}
                  >
                    Create from preset
                  </button>
                }
              />
            </Card>
          ) : (
            <div className="grid cols-2">
              {list.map((team) => (
                <Card
                  key={team.id}
                  title={
                    <Link to={`/teams/${team.id}`} className="col" style={{ gap: 1 }}>
                      <h2 style={{ textTransform: 'none', fontSize: 15, color: 'var(--text)' }}>
                        {team.name}
                      </h2>
                      <span className="tiny muted">
                        {team.agents.length} agents · updated {formatRelative(team.updatedAt)}
                      </span>
                    </Link>
                  }
                  actions={
                    <Link className="btn btn-sm" to={`/teams/${team.id}`}>
                      Open
                    </Link>
                  }
                >
                  <div className="col" style={{ gap: 12 }}>
                    {team.description && (
                      <p className="small muted">{truncate(team.description, 160)}</p>
                    )}
                    <div className="row">
                      {team.agents.map((agent) => (
                        <Link key={agent.id} to={`/agents/${agent.id}`} title={agent.handle}>
                          <AgentAvatar agent={agent} />
                        </Link>
                      ))}
                    </div>
                    {team.workspace && (
                      <span className="tiny muted truncate mono">{team.workspace}</span>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )
        }
      </Async>

      {dialog === 'blank' && <CreateTeamDialog onClose={close} />}
      {dialog === 'preset' && <PresetDialog onClose={close} />}
      {dialog === 'import' && <ImportDialog onClose={close} />}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Create blank
 * ------------------------------------------------------------------ */

function CreateTeamDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const act = useAction();
  const { settings } = useCatalog();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [workspace, setWorkspace] = useState(settings.defaultWorkspace ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    await act(async () => {
      const team = await client.createTeam({
        name,
        description: description || undefined,
        workspace: workspace || undefined,
      });
      onClose();
      navigate(`/teams/${team.id}`);
    }, 'Team created');
    setBusy(false);
  };

  return (
    <Modal
      title="New team"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !name.trim()}
            onClick={() => void submit()}
          >
            Create team
          </button>
        </>
      }
    >
      <Field label="Name">
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Platform team"
        />
      </Field>
      <Field label="Description" hint="Optional. What is this team for?">
        <input
          className="input"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <WorkspaceField value={workspace} onChange={setWorkspace} />
      <div className="notice-box">
        A blank team starts empty — add agents from templates once it exists.
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Create from preset, with per-agent model and effort
 * ------------------------------------------------------------------ */

export function PresetDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const act = useAction();
  const { catalog, settings } = useCatalog();

  const [presetId, setPresetId] = useState(catalog.presets[0]?.id ?? '');
  const [name, setName] = useState('');
  const [workspace, setWorkspace] = useState(settings.defaultWorkspace ?? '');
  const [overrides, setOverrides] = useState<Record<string, { model?: string; effort?: AgentEffort }>>({});
  const [busy, setBusy] = useState(false);

  const preset = catalog.presets.find((p) => p.id === presetId);

  // The catalog already carries what `createTeamFromPreset` will actually
  // create, so this preview only layers the user's overrides on top — it never
  // invents a model or effort the core would not produce.
  const members = useMemo(
    () =>
      (preset?.members ?? []).map((member) => ({
        handle: member.handle,
        name: member.name,
        role: member.role,
        orchestrator: member.orchestrator,
        model: overrides[member.handle]?.model ?? member.model,
        effort: overrides[member.handle]?.effort ?? member.effort,
      })),
    [preset, overrides],
  );

  const patch = (handle: string, value: { model?: string; effort?: AgentEffort }) =>
    setOverrides((current) => ({ ...current, [handle]: { ...current[handle], ...value } }));

  const submit = async () => {
    setBusy(true);
    await act(async () => {
      const team = await client.createTeamFromPreset({
        presetId,
        name: name || undefined,
        workspace: workspace || undefined,
        overrides,
      });
      onClose();
      navigate(`/teams/${team.id}`);
    }, 'Team created');
    setBusy(false);
  };

  return (
    <Modal
      wide
      title="New team from preset"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !presetId}
            onClick={() => void submit()}
          >
            Create {members.length} agents
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 8 }}>
        {catalog.presets.map((option) => (
          <button
            key={option.id}
            type="button"
            className="choice"
            aria-pressed={option.id === presetId}
            onClick={() => setPresetId(option.id)}
          >
            <span className="col" style={{ gap: 2 }}>
              <span className="strong">{option.name}</span>
              <span className="small muted">{option.description}</span>
            </span>
            <span className="badge right">{option.members.length} agents</span>
          </button>
        ))}
      </div>

      <div className="form-grid">
        <Field label="Team name" hint="Defaults to the preset's name.">
          <input
            className="input"
            value={name}
            placeholder={preset?.name ?? ''}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <WorkspaceField value={workspace} onChange={setWorkspace} />
      </div>

      <div className="col" style={{ gap: 10 }}>
        <span className="label">Model and effort, per agent</span>
        {members.map((member) => (
          <div key={member.handle} className="agent-card" style={{ flexWrap: 'wrap' }}>
            <span className="col" style={{ gap: 1, minWidth: 150 }}>
              <span className="strong">
                {member.handle}
                {member.orchestrator && <span className="tiny muted"> · orchestrator</span>}
              </span>
              <span className="tiny muted truncate">{member.role}</span>
            </span>
            <div className="row right" style={{ gap: 8 }}>
              <div style={{ minWidth: 190 }}>
                <ModelSelect value={member.model} onChange={(model) => patch(member.handle, { model })} />
              </div>
              <EffortSelect
                value={member.effort}
                onChange={(effort) => patch(member.handle, { effort })}
              />
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

function ImportDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const act = useAction();
  const [yaml, setYaml] = useState('');
  const [name, setName] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    await act(async () => {
      const result = await client.importTeam(yaml, name || undefined);
      setWarnings(result.warnings);
      if (result.warnings.length === 0) {
        onClose();
        navigate(`/teams/${result.team.id}`);
      } else {
        navigate(`/teams/${result.team.id}`);
        onClose();
      }
    }, 'Team imported');
    setBusy(false);
  };

  return (
    <Modal
      wide
      title="Import team from YAML"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !yaml.trim()}
            onClick={() => void submit()}
          >
            Import
          </button>
        </>
      }
    >
      <Field label="Name override" hint="Optional — keeps the name in the file when empty.">
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
      </Field>

      <Field label="YAML">
        <textarea
          className="textarea"
          style={{ minHeight: 260 }}
          value={yaml}
          spellCheck={false}
          placeholder="Paste an exported team here…"
          onChange={(event) => setYaml(event.target.value)}
        />
      </Field>

      <label className="btn btn-sm" style={{ alignSelf: 'flex-start' }}>
        Choose a file…
        <input
          type="file"
          accept=".yaml,.yml,text/yaml,text/plain"
          style={{ display: 'none' }}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file) setYaml(await file.text());
          }}
        />
      </label>

      {warnings.length > 0 && (
        <div className="notice-box">
          <strong>Imported with warnings</strong>
          <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
