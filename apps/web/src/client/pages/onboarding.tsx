import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  APPROVAL_CATEGORIES,
  APPROVAL_CATEGORY_LABELS,
  type AgentEffort,
  type ApprovalCategory,
} from '@claude-team/domain';
import type { EnvironmentDto, ProviderHealthDto } from '@claude-team/protocol';
import { client } from '../api';
import { EffortSelect, ModelSelect, WorkspaceField } from '../components/pickers';
import { Field } from '../components/ui';
import { useCatalog } from '../state/catalog';
import { useAction } from '../state/toasts';

/**
 * First-run wizard, mirroring the TUI's flow: what we found, where the work
 * happens, which team, how hard each agent thinks, what needs your approval,
 * and the first objective.
 */

const STEPS = ['Environment', 'Workspace', 'Team', 'Agents', 'Permissions', 'Objective'] as const;
type Step = (typeof STEPS)[number];

export function OnboardingPage() {
  const navigate = useNavigate();
  const act = useAction();
  const { catalog, settings, reload } = useCatalog();

  const [step, setStep] = useState(0);
  const [environment, setEnvironment] = useState<EnvironmentDto | undefined>();
  const [health, setHealth] = useState<ProviderHealthDto | undefined>();
  const [workspace, setWorkspace] = useState(settings.defaultWorkspace ?? '');
  const [presetId, setPresetId] = useState(catalog.presets[0]?.id ?? '');
  const [teamName, setTeamName] = useState('');
  const [overrides, setOverrides] = useState<Record<string, { model?: string; effort?: AgentEffort }>>({});
  const [approvals, setApprovals] = useState<string[]>(settings.requireApprovalFor);
  const [autoApprove, setAutoApprove] = useState(settings.autoApproveAll);
  const [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void client
      .detectEnvironment()
      .then((result) => {
        setEnvironment(result);
        setWorkspace((current) => current || result.workspace.path);
      })
      .catch(() => undefined);
    void client
      .checkProvider()
      .then(setHealth)
      .catch(() => undefined);
  }, []);

  const preset = catalog.presets.find((p) => p.id === presetId);

  // Resolved by the core and delivered in the catalog: what you see here is
  // exactly what `createTeamFromPreset` will create, plus your overrides.
  const members = useMemo(
    () =>
      (preset?.members ?? []).map((member) => ({
        handle: member.handle,
        role: member.role,
        orchestrator: member.orchestrator,
        model: overrides[member.handle]?.model ?? member.model,
        effort: overrides[member.handle]?.effort ?? member.effort,
      })),
    [preset, overrides],
  );

  const finish = async () => {
    setBusy(true);
    await act(async () => {
      await client.updateSettings({
        defaultWorkspace: workspace || null,
        requireApprovalFor: approvals,
        autoApproveAll: autoApprove,
      });
      const team = await client.createTeamFromPreset({
        presetId,
        name: teamName || undefined,
        workspace: workspace || undefined,
        overrides,
      });
      await client.completeOnboarding();
      reload();

      if (objective.trim()) {
        const run = await client.startRun({ teamId: team.id, objective, workspace: workspace || undefined });
        navigate(`/runs/${run.id}`);
      } else {
        navigate(`/teams/${team.id}`);
      }
    }, 'You are set up');
    setBusy(false);
  };

  const current: Step = STEPS[step];

  return (
    <div className="wizard">
      <div className="wizard-card">
        <div className="wizard-steps">
          {STEPS.map((label, index) => (
            <span
              key={label}
              className={`wizard-step${index === step ? ' current' : ''}${index < step ? ' done' : ''}`}
            >
              {index < step ? '✓' : index + 1} {label}
            </span>
          ))}
        </div>

        <div className="wizard-body">
          {current === 'Environment' && (
            <>
              <h1>Welcome to Claude Team</h1>
              <p className="muted">
                Teams of Claude agents that plan together, work in parallel and report back. Here is
                what we found on this machine.
              </p>
              <div className="col" style={{ gap: 8 }}>
                <Detail
                  label="Claude CLI"
                  value={
                    environment
                      ? environment.claude.cliInstalled
                        ? (environment.claude.cliVersion ?? 'installed')
                        : 'not found'
                      : 'checking…'
                  }
                  ok={environment?.claude.cliInstalled}
                />
                <Detail
                  label="Authentication"
                  value={environment?.claude.authMethod ?? 'checking…'}
                  ok={environment?.claude.authenticated}
                />
                <Detail
                  label="Provider"
                  value={health?.detail ?? 'checking…'}
                  ok={health?.ok}
                />
                <Detail
                  label="MCP servers"
                  value={
                    environment ? `${environment.claude.mcpServers.length} configured` : 'checking…'
                  }
                />
                <Detail
                  label="Storage"
                  value={
                    environment
                      ? `${environment.storage.driver} · ${environment.storage.location}`
                      : 'checking…'
                  }
                />
                <Detail
                  label="Existing teams"
                  value={environment ? String(environment.existingTeams) : 'checking…'}
                />
              </div>
              {health && !health.ok && (
                <div className="notice-box">
                  You can still set everything up — connect Claude later from Settings, or run the
                  server with <code>--provider fake</code> to explore without tokens.
                </div>
              )}
            </>
          )}

          {current === 'Workspace' && (
            <>
              <h1>Where should the team work?</h1>
              <p className="muted">
                Agents read and write inside this directory. A git repository is ideal — you can
                review everything they do with <code>git diff</code>.
              </p>
              <WorkspaceField value={workspace} onChange={setWorkspace} />
            </>
          )}

          {current === 'Team' && (
            <>
              <h1>Pick a starting team</h1>
              <p className="muted">
                Every preset expands into real, fully editable agents — nothing is locked in.
              </p>
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
              <Field label="Team name" hint="Optional — defaults to the preset name.">
                <input
                  className="input"
                  value={teamName}
                  placeholder={preset?.name ?? ''}
                  onChange={(event) => setTeamName(event.target.value)}
                />
              </Field>
            </>
          )}

          {current === 'Agents' && (
            <>
              <h1>Model and effort, per agent</h1>
              <p className="muted">
                Each agent runs with its own model and reasoning effort. Give the orchestrator and
                the reviewers more thinking; keep the mechanical work fast.
              </p>
              <div className="col" style={{ gap: 8 }}>
                {members.map((member) => (
                  <div key={member.handle} className="agent-card" style={{ flexWrap: 'wrap' }}>
                    <span className="col" style={{ gap: 1, minWidth: 140 }}>
                      <span className="strong">
                        {member.handle}
                        {member.orchestrator && <span className="tiny muted"> · orchestrator</span>}
                      </span>
                      <span className="tiny muted">{member.role}</span>
                    </span>
                    <div className="row right" style={{ gap: 8 }}>
                      <div style={{ minWidth: 180 }}>
                        <ModelSelect
                          value={member.model}
                          onChange={(model) =>
                            setOverrides((current) => ({
                              ...current,
                              [member.handle]: { ...current[member.handle], model },
                            }))
                          }
                        />
                      </div>
                      <EffortSelect
                        value={member.effort}
                        onChange={(effort) =>
                          setOverrides((current) => ({
                            ...current,
                            [member.handle]: { ...current[member.handle], effort },
                          }))
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {current === 'Permissions' && (
            <>
              <h1>What needs your approval?</h1>
              <p className="muted">
                Agents ask before doing anything in these categories. You can refine permissions per
                agent afterwards.
              </p>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={autoApprove}
                  onChange={(event) => setAutoApprove(event.target.checked)}
                />
                <span>
                  <strong>Approve everything automatically</strong>
                  <span className="hint"> — fastest, and the least safe.</span>
                </span>
              </label>
              <div className="col" style={{ gap: 0 }}>
                {APPROVAL_CATEGORIES.map((category: ApprovalCategory) => (
                  <label key={category} className="checkbox">
                    <input
                      type="checkbox"
                      disabled={autoApprove}
                      checked={approvals.includes(category)}
                      onChange={() =>
                        setApprovals((current) =>
                          current.includes(category)
                            ? current.filter((c) => c !== category)
                            : [...current, category],
                        )
                      }
                    />
                    <span>{APPROVAL_CATEGORY_LABELS[category]}</span>
                  </label>
                ))}
              </div>
            </>
          )}

          {current === 'Objective' && (
            <>
              <h1>Give them something to do</h1>
              <p className="muted">
                Optional. The orchestrator turns an objective into a task graph and delegates it.
              </p>
              <Field label="First objective">
                <textarea
                  className="textarea"
                  style={{ minHeight: 120 }}
                  value={objective}
                  placeholder="Review this codebase and report the three riskiest areas."
                  onChange={(event) => setObjective(event.target.value)}
                />
              </Field>
              <div className="notice-box small">
                <strong>{preset?.name}</strong> in <code>{workspace || 'no workspace'}</code> —{' '}
                {members.map((m) => `${m.handle} (${m.model}/${m.effort})`).join(', ')}
              </div>
            </>
          )}
        </div>

        <div className="wizard-foot">
          <button
            type="button"
            className="btn"
            disabled={step === 0 || busy}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            Back
          </button>
          <span className="right" />
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => navigate('/dashboard')}>
            Skip
          </button>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || (current === 'Team' && !presetId)}
              onClick={() => setStep((s) => s + 1)}
            >
              Continue
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void finish()}>
              {objective.trim() ? 'Create team and start' : 'Create team'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Detail({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="spread">
      <span className="muted small">{label}</span>
      <span className={`small ${ok === undefined ? '' : ok ? 'tone-success tone-text' : 'tone-warning tone-text'}`}>
        {value}
      </span>
    </div>
  );
}
