import { useEffect, useState } from 'react';
import {
  PERMISSION_MODES,
  TOOL_GROUPS,
  DEFAULT_BUDGET,
  budgetProblem,
  isUnmetered,
  permissionMode,
  unmetered,
  type Budget,
  type AgentEffort,
  type PermissionMode,
  type ToolGroupId,
  type ToolPermission,
} from '@claude-team/domain';
import type { WorkspaceDto } from '@claude-team/protocol';
import { PERMISSION_MODE_UI } from '@claude-team/ui-shared';
import { client } from '../api';
import { useCatalog } from '../state/catalog';
import { effortUi } from '../lib/tone';
import { Field, Segmented } from './ui';

/* ------------------------------------------------------------------ *
 * Model & effort — always per agent, never applied to a whole team.
 * ------------------------------------------------------------------ */

export function ModelSelect({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (model: string) => void;
  id?: string;
}) {
  const { catalog } = useCatalog();
  const known = catalog.models.some((model) => model.id === value);

  return (
    <select
      id={id}
      className="select"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {!known && value && <option value={value}>{value} (custom)</option>}
      {catalog.models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.label}
          {model.tier ? ` · ${model.tier}` : ''}
          {model.supportsEffort === false ? ' · no effort control' : ''}
        </option>
      ))}
    </select>
  );
}

export function EffortSelect({
  value,
  onChange,
}: {
  value: AgentEffort;
  onChange: (effort: AgentEffort) => void;
}) {
  const { catalog } = useCatalog();
  return (
    <Segmented<AgentEffort>
      value={value}
      onChange={onChange}
      toneOf={(effort) => effortUi(effort).tone}
      options={catalog.efforts.map((effort) => ({
        value: effort.id,
        label: effort.label,
        title: effort.description,
      }))}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Workspace
 * ------------------------------------------------------------------ */

export function WorkspaceField({
  value,
  onChange,
  label = 'Workspace',
  hint,
}: {
  value: string;
  onChange: (path: string) => void;
  label?: string;
  hint?: string;
}) {
  const [info, setInfo] = useState<WorkspaceDto | undefined>();
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!value.trim()) {
      setInfo(undefined);
      return;
    }
    let cancelled = false;
    setChecking(true);
    const timer = setTimeout(() => {
      void client
        .inspectWorkspace(value.trim())
        .then((result) => !cancelled && setInfo(result))
        .catch(() => !cancelled && setInfo(undefined))
        .finally(() => !cancelled && setChecking(false));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value]);

  return (
    <Field
      label={label}
      hint={
        checking ? (
          'Checking…'
        ) : info ? (
          info.exists ? (
            <span className={info.git.isRepo ? 'tone-success tone-text' : 'muted'}>
              {info.summary ?? (info.isDirectory ? 'Directory exists (not a git repo).' : 'Not a directory.')}
            </span>
          ) : (
            <span className="tone-danger tone-text">This path does not exist.</span>
          )
        ) : (
          (hint ?? 'Absolute path, or ~ for your home directory.')
        )
      }
    >
      <input
        className="input"
        value={value}
        placeholder="~/code/my-project"
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
    </Field>
  );
}

/* ------------------------------------------------------------------ *
 * Tool permissions
 * ------------------------------------------------------------------ */

/**
 * The permission list an edit produces: every group, with an explicit mode.
 *
 * Groups the user never touched keep the mode the *runtime* gives them
 * (`permissionMode`, which falls back to the group's default), so saving from
 * here cannot leave a group unset — which is what made the two surfaces
 * disagree about an agent's effective permissions.
 */
export function withPermissionMode(
  permissions: ToolPermission[],
  group: ToolGroupId,
  mode: PermissionMode,
): ToolPermission[] {
  return TOOL_GROUPS.map((id) => ({
    group: id,
    mode: id === group ? mode : permissionMode(permissions, id),
  }));
}

/**
 * What an unset capability group means is a runtime rule, not a rendering
 * detail: `permissionMode` is the same function the engine consults, so this
 * editor cannot show `deny` where the agent would actually be allowed.
 */
export function PermissionEditor({
  value,
  onChange,
}: {
  value: ToolPermission[];
  onChange: (permissions: ToolPermission[]) => void;
}) {
  const { catalog } = useCatalog();

  const modeOf = (group: ToolGroupId): PermissionMode => permissionMode(value, group);

  const setMode = (group: ToolGroupId, mode: PermissionMode) =>
    onChange(withPermissionMode(value, group, mode));

  return (
    <div className="col" style={{ gap: 10 }}>
      {catalog.toolGroups.map((group) => (
        <div key={group.id} className="spread">
          <span className="col" style={{ gap: 1 }}>
            <span className="strong">
              {group.label}
              {group.sensitive && (
                <span className="tiny tone-warning tone-text"> · sensitive</span>
              )}
            </span>
            <span className="tiny muted">{group.description}</span>
          </span>
          <Segmented<PermissionMode>
            value={modeOf(group.id)}
            onChange={(mode) => setMode(group.id, mode)}
            toneOf={(mode) => PERMISSION_MODE_UI[mode].tone}
            options={PERMISSION_MODES.map((mode) => ({
              value: mode,
              label: `${PERMISSION_MODE_UI[mode].glyph} ${PERMISSION_MODE_UI[mode].label}`,
            }))}
          />
        </div>
      ))}
    </div>
  );
}


/* ------------------------------------------------------------------ *
 * Budget
 * ------------------------------------------------------------------ */

/**
 * The one budget editor, used wherever a budget is set: application defaults,
 * a team, or a single run.
 *
 * Its point is the switch. Running **unmetered** — no token cap, no money cap
 * — is a deliberate choice for work that is worth whatever it costs, and it
 * has to be one control rather than "remember to clear these two fields". What
 * it never does is remove the stop conditions: the time and interaction limits
 * stay, and the domain refuses a budget that has neither.
 */
export function BudgetFields({
  budget,
  onChange,
  idPrefix = 'budget',
}: {
  budget: Budget;
  onChange: (budget: Budget) => void;
  idPrefix?: string;
}) {
  const unmeteredNow = isUnmetered(budget);
  const problem = budgetProblem(budget);

  const setField = (key: keyof Budget, raw: string) =>
    onChange({ ...budget, [key]: raw === '' ? undefined : Number(raw) });

  const toggleUnmetered = (on: boolean) =>
    onChange(
      on
        ? unmetered(budget)
        : {
            ...budget,
            maxTokens: budget.maxTokens ?? DEFAULT_BUDGET.maxTokens,
            maxCostUsd: budget.maxCostUsd ?? DEFAULT_BUDGET.maxCostUsd,
          },
    );

  return (
    <>
      <button
        type="button"
        className={`auto-mode auto-mode-block auto-mode-${unmeteredNow ? 'on' : 'off'}`}
        aria-pressed={unmeteredNow}
        onClick={() => toggleUnmetered(!unmeteredNow)}
      >
        <span className="auto-mode-switch" aria-hidden>
          <span className="auto-mode-knob" />
        </span>
        <span className="col" style={{ gap: 2, minWidth: 0, textAlign: 'left' }}>
          <span className="strong">Unmetered — no token or cost cap</span>
          <span className="tiny muted">
            The run stops on time and on the number of agent interactions, not on what it spent.
          </span>
        </span>
        <span className="auto-mode-state right">{unmeteredNow ? 'on' : 'off'}</span>
      </button>

      <div className="form-grid" style={{ marginTop: 12 }}>
        {!unmeteredNow && (
          <>
            <Field label="Max tokens per run">
              <input
                id={`${idPrefix}-tokens`}
                className="input"
                type="number"
                min={1}
                value={budget.maxTokens ?? ''}
                onChange={(event) => setField('maxTokens', event.target.value)}
              />
            </Field>
            <Field label="Max cost per run (USD)">
              <input
                id={`${idPrefix}-cost`}
                className="input"
                type="number"
                min={0}
                step={0.5}
                value={budget.maxCostUsd ?? ''}
                onChange={(event) => setField('maxCostUsd', event.target.value)}
              />
            </Field>
          </>
        )}
        <Field
          label="Max duration (minutes)"
          hint={unmeteredNow ? 'One of the two things that still stops the run.' : undefined}
        >
          <input
            id={`${idPrefix}-minutes`}
            className="input"
            type="number"
            min={1}
            value={budget.maxDurationMinutes ?? ''}
            onChange={(event) => setField('maxDurationMinutes', event.target.value)}
          />
        </Field>
        <Field
          label="Max agent interactions"
          hint={unmeteredNow ? 'The other one. Each activation of an agent counts.' : undefined}
        >
          <input
            id={`${idPrefix}-activations`}
            className="input"
            type="number"
            min={1}
            value={budget.maxAgentActivations ?? ''}
            onChange={(event) => setField('maxAgentActivations', event.target.value)}
          />
        </Field>
      </div>

      {problem && <div className="error-box" style={{ marginTop: 10 }}>{problem}</div>}
    </>
  );
}
