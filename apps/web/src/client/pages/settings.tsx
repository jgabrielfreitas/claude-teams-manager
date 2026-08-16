import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  APPROVAL_CATEGORIES,
  APPROVAL_CATEGORY_LABELS,
  type AgentEffort,
  type ApprovalCategory,
} from '@claude-team/domain';
import type { ProviderHealthDto, SettingsDto } from '@claude-team/protocol';
import { formatRelative } from '@claude-team/ui-shared';
import { client } from '../api';
import { EffortSelect, ModelSelect, WorkspaceField } from '../components/pickers';
import { Card, Field, Segmented } from '../components/ui';
import { useResource } from '../hooks/use-resource';
import { AUTO_MODE_CONSEQUENCE } from '../state/auto-mode';
import { useCatalog } from '../state/catalog';
import { useAction, useToasts } from '../state/toasts';

/** Every application setting, plus where the data lives and whether Claude answers. */
export function SettingsPage() {
  const { settings } = useCatalog();
  // Settings refresh from the event stream, so a form seeded before a change
  // made elsewhere (the TUI, another tab) would PATCH every field back to the
  // old snapshot on the next Save. A new `updatedAt` re-seeds the form.
  return <SettingsForm key={settings.updatedAt} settings={settings} />;
}

function SettingsForm({ settings }: { settings: SettingsDto }) {
  const { catalog, reload } = useCatalog();
  const [params] = useSearchParams();
  const act = useAction();
  const { notify } = useToasts();

  const [form, setForm] = useState<SettingsDto>(settings);
  const [health, setHealth] = useState<ProviderHealthDto | undefined>();
  const environment = useResource(() => client.detectEnvironment(), []);

  const set = <K extends keyof SettingsDto>(key: K, value: SettingsDto[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const setBudget = (key: keyof SettingsDto['defaultBudget'], value: string) =>
    setForm((current) => ({
      ...current,
      defaultBudget: {
        ...current.defaultBudget,
        [key]: value === '' ? undefined : Number(value),
      },
    }));

  // Auto mode is one idea made of two settings; the master switch moves the
  // pair, and the individual boxes below stay available for anyone who really
  // wants approvals automatic but questions blocking.
  const autoModeOn = form.autoApproveAll && form.autoAnswerQuestions;
  const autoModeHalf = form.autoApproveAll !== form.autoAnswerQuestions;
  const setAutoMode = (on: boolean) =>
    setForm((current) => ({ ...current, autoApproveAll: on, autoAnswerQuestions: on }));

  const toggleCategory = (category: ApprovalCategory) =>
    set(
      'requireApprovalFor',
      form.requireApprovalFor.includes(category)
        ? form.requireApprovalFor.filter((c) => c !== category)
        : [...form.requireApprovalFor, category],
    );

  const save = () =>
    void act(async () => {
      await client.updateSettings({
        defaultWorkspace: form.defaultWorkspace || null,
        defaultModel: form.defaultModel,
        defaultOrchestratorModel: form.defaultOrchestratorModel,
        defaultEffort: form.defaultEffort,
        provider: form.provider,
        defaultBudget: form.defaultBudget,
        requireApprovalFor: form.requireApprovalFor,
        autoApproveAll: form.autoApproveAll,
        autoAnswerQuestions: form.autoAnswerQuestions,
        questionTimeoutMs: form.questionTimeoutMs,
        maxHops: form.maxHops,
        maxRecursionDepth: form.maxRecursionDepth,
        askTimeoutMs: form.askTimeoutMs,
        webPort: form.webPort,
        theme: form.theme,
        telemetry: form.telemetry,
      });
      reload();
    }, 'Settings saved');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="page-sub">
            Defaults for new teams and agents, guardrails for every run, and where your data lives.
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={save}>
            Save settings
          </button>
        </div>
      </div>

      <div className="grid main-aside">
        <div className="col" style={{ gap: 20 }}>
          <Card title="Defaults for new agents">
            <div className="form-grid">
              <Field label="Default model">
                <ModelSelect value={form.defaultModel} onChange={(model) => set('defaultModel', model)} />
              </Field>
              <Field label="Default orchestrator model">
                <ModelSelect
                  value={form.defaultOrchestratorModel}
                  onChange={(model) => set('defaultOrchestratorModel', model)}
                />
              </Field>
              <Field label="Default effort">
                <EffortSelect
                  value={form.defaultEffort}
                  onChange={(effort: AgentEffort) => set('defaultEffort', effort)}
                />
              </Field>
            </div>
            <div style={{ marginTop: 14 }}>
              <WorkspaceField
                value={form.defaultWorkspace ?? ''}
                onChange={(value) => set('defaultWorkspace', value)}
                label="Default workspace"
              />
            </div>
          </Card>

          <Card title="Run guardrails">
            <div className="form-grid">
              <Field label="Max tokens per run">
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={form.defaultBudget.maxTokens ?? ''}
                  onChange={(event) => setBudget('maxTokens', event.target.value)}
                />
              </Field>
              <Field label="Max cost per run (USD)">
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={0.5}
                  value={form.defaultBudget.maxCostUsd ?? ''}
                  onChange={(event) => setBudget('maxCostUsd', event.target.value)}
                />
              </Field>
              <Field label="Max duration (minutes)">
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={form.defaultBudget.maxDurationMinutes ?? ''}
                  onChange={(event) => setBudget('maxDurationMinutes', event.target.value)}
                />
              </Field>
              <Field label="Max agent activations">
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={form.defaultBudget.maxAgentActivations ?? ''}
                  onChange={(event) => setBudget('maxAgentActivations', event.target.value)}
                />
              </Field>
            </div>

            <hr />

            <div className="form-grid">
              <Field label="Max message hops" hint="Guards against agents talking in circles.">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={64}
                  value={form.maxHops}
                  onChange={(event) => set('maxHops', Number(event.target.value))}
                />
              </Field>
              <Field label="Max recursion depth" hint="Nested synchronous asks.">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={16}
                  value={form.maxRecursionDepth}
                  onChange={(event) => set('maxRecursionDepth', Number(event.target.value))}
                />
              </Field>
              <Field label="Ask timeout (ms)">
                <input
                  className="input"
                  type="number"
                  min={1000}
                  step={1000}
                  value={form.askTimeoutMs}
                  onChange={(event) => set('askTimeoutMs', Number(event.target.value))}
                />
              </Field>
            </div>
          </Card>

          <Card title="Auto mode">
            <button
              type="button"
              className={`auto-mode auto-mode-block auto-mode-${
                autoModeOn ? 'on' : autoModeHalf ? 'partial' : 'off'
              }`}
              aria-pressed={autoModeOn}
              onClick={() => setAutoMode(!autoModeOn)}
            >
              <span className="auto-mode-switch" aria-hidden>
                <span className="auto-mode-knob" />
              </span>
              <span className="col" style={{ gap: 2, minWidth: 0, textAlign: 'left' }}>
                <span className="strong">Auto mode — the run never stops to ask you</span>
                <span className="tiny muted">{AUTO_MODE_CONSEQUENCE}</span>
              </span>
              <span className="auto-mode-state right">
                {autoModeOn ? 'on' : autoModeHalf ? 'half on' : 'off'}
              </span>
            </button>

            {autoModeOn && (
              <div className="error-box" style={{ marginTop: 12 }}>
                Every permission is granted and every question is answered without you. Only
                sensible in a throwaway workspace.
              </div>
            )}

            <hr />

            <span className="label">Or decide each half separately</span>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.autoApproveAll}
                onChange={(event) => set('autoApproveAll', event.target.checked)}
              />
              <span>
                <strong>Approve everything automatically</strong>
                <span className="hint"> — agents act without asking for permission.</span>
              </span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.autoAnswerQuestions}
                onChange={(event) => set('autoAnswerQuestions', event.target.checked)}
              />
              <span>
                <strong>Answer questions automatically</strong>
                <span className="hint">
                  {' '}
                  — an agent that asks you something is told to decide for itself and state the
                  assumption, instead of blocking.
                </span>
              </span>
            </label>

            <hr />

            <Field
              label="Question timeout (minutes)"
              hint="How long a question waits for you before the agent is told to decide on its own."
            >
              <input
                className="input"
                type="number"
                min={1}
                max={1440}
                disabled={form.autoAnswerQuestions}
                value={Math.round(form.questionTimeoutMs / 60_000)}
                onChange={(event) =>
                  set('questionTimeoutMs', Math.max(1, Number(event.target.value)) * 60_000)
                }
              />
            </Field>
          </Card>

          <Card title="Approvals">
            <span className="label">Always ask before</span>
            <div className="col" style={{ gap: 0 }}>
              {APPROVAL_CATEGORIES.map((category) => (
                <label key={category} className="checkbox">
                  <input
                    type="checkbox"
                    disabled={form.autoApproveAll}
                    checked={form.requireApprovalFor.includes(category)}
                    onChange={() => toggleCategory(category)}
                  />
                  <span>{APPROVAL_CATEGORY_LABELS[category]}</span>
                </label>
              ))}
            </div>
          </Card>

          <Card title="Application">
            <div className="form-grid">
              <Field
                label="Provider"
                hint="Which engine executes agents. Takes effect the next time the server starts."
              >
                <select
                  className="input"
                  value={form.provider}
                  onChange={(event) => set('provider', event.target.value)}
                >
                  {catalog.providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                      {provider.current ? ' — running now' : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Web port" hint="Takes effect the next time the server starts.">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={65535}
                  value={form.webPort}
                  onChange={(event) => set('webPort', Number(event.target.value))}
                />
              </Field>
              <Field label="Theme">
                <Segmented<SettingsDto['theme']>
                  value={form.theme}
                  onChange={(theme) => set('theme', theme)}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'dark', label: 'Dark' },
                    { value: 'light', label: 'Light' },
                  ]}
                />
              </Field>
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.telemetry}
                onChange={(event) => set('telemetry', event.target.checked)}
              />
              <span>Send anonymous usage telemetry</span>
            </label>
          </Card>
        </div>

        <div className="col" style={{ gap: 20 }}>
          <Card title="Claude connection">
            <div className="col" style={{ gap: 10 }}>
              <button
                type="button"
                className="btn btn-block"
                onClick={() =>
                  void act(async () => {
                    const result = await client.checkProvider();
                    setHealth(result);
                    notify(result.detail, result.ok ? 'success' : 'danger');
                  })
                }
              >
                Check connection
              </button>
              {health && (
                <div className={health.ok ? 'notice-box' : 'error-box'}>
                  <div className="col" style={{ gap: 2 }}>
                    <span>{health.detail}</span>
                    <span className="tiny muted">
                      {health.authenticated ? 'authenticated' : 'not authenticated'}
                      {health.authSource ? ` · ${health.authSource}` : ''}
                      {health.version ? ` · ${health.version}` : ''}
                    </span>
                  </div>
                </div>
              )}
              {environment.data && (
                <div className="col small" style={{ gap: 6 }}>
                  <div className="spread">
                    <span className="muted">CLI</span>
                    <span>
                      {environment.data.claude.cliInstalled
                        ? (environment.data.claude.cliVersion ?? 'installed')
                        : 'not installed'}
                    </span>
                  </div>
                  <div className="spread">
                    <span className="muted">Auth</span>
                    <span>{environment.data.claude.authMethod}</span>
                  </div>
                  <div className="spread">
                    <span className="muted">MCP servers</span>
                    <span>{environment.data.claude.mcpServers.length}</span>
                  </div>
                </div>
              )}
            </div>
          </Card>

          <Card title="Storage">
            <div className="col small" style={{ gap: 8 }}>
              <div className="spread">
                <span className="muted">Driver</span>
                <span>{environment.data?.storage.driver ?? '…'}</span>
              </div>
              <div className="col" style={{ gap: 2 }}>
                <span className="muted">Location</span>
                <span className="mono" style={{ wordBreak: 'break-all' }}>
                  {environment.data?.storage.location ?? '…'}
                </span>
              </div>
              <div className="spread">
                <span className="muted">Settings updated</span>
                <span>{formatRelative(settings.updatedAt)}</span>
              </div>
            </div>
          </Card>

          <Card
            title="Onboarding & help"
            className={params.get('tab') === 'help' ? 'tone-info' : undefined}
          >
            <div className="col" style={{ gap: 10 }}>
              <Link className="btn btn-block" to="/onboarding">
                Run onboarding again
              </Link>
              <div className="col small" style={{ gap: 6 }}>
                <div className="spread">
                  <span className="muted">Command palette</span>
                  <span className="kbd">⌘K</span>
                </div>
                <div className="spread">
                  <span className="muted">Search</span>
                  <span className="kbd">/</span>
                </div>
                <div className="spread">
                  <span className="muted">Close a dialog</span>
                  <span className="kbd">esc</span>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
