import { useEffect, useState } from 'react';
import type { AgentEffort, ToolGroupId, ToolPermission, PermissionMode } from '@claude-team/domain';
import type { WorkspaceDto } from '@claude-team/protocol';
import { client } from '../api';
import { useCatalog } from '../state/catalog';
import { effortUi, toneClass } from '../lib/tone';
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

/** The per-agent pair, side by side — the one control users reach for most. */
export function ModelEffortRow({
  model,
  effort,
  onModel,
  onEffort,
}: {
  model: string;
  effort: AgentEffort;
  onModel: (model: string) => void;
  onEffort: (effort: AgentEffort) => void;
}) {
  return (
    <div className="form-grid">
      <Field label="Model" hint="This agent only.">
        <ModelSelect value={model} onChange={onModel} />
      </Field>
      <Field label="Effort" hint="Reasoning depth for this agent only.">
        <EffortSelect value={effort} onChange={onEffort} />
      </Field>
    </div>
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

const MODES: PermissionMode[] = ['allow', 'ask', 'deny'];

const MODE_TONE = {
  allow: 'success',
  ask: 'warning',
  deny: 'muted',
} as const;

export function PermissionEditor({
  value,
  onChange,
}: {
  value: ToolPermission[];
  onChange: (permissions: ToolPermission[]) => void;
}) {
  const { catalog } = useCatalog();

  const modeOf = (group: ToolGroupId): PermissionMode =>
    value.find((permission) => permission.group === group)?.mode ?? 'deny';

  const setMode = (group: ToolGroupId, mode: PermissionMode) => {
    const next = value.some((permission) => permission.group === group)
      ? value.map((permission) => (permission.group === group ? { ...permission, mode } : permission))
      : [...value, { group, mode }];
    onChange(next);
  };

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
            toneOf={(mode) => MODE_TONE[mode]}
            options={MODES.map((mode) => ({ value: mode, label: mode }))}
          />
        </div>
      ))}
    </div>
  );
}

export function PermissionSummary({ tools }: { tools: ToolPermission[] }) {
  const { catalog } = useCatalog();
  return (
    <div className="row" style={{ gap: 6 }}>
      {tools.map((permission) => {
        const group = catalog.toolGroups.find((g) => g.id === permission.group);
        return (
          <span
            key={permission.group}
            className={`badge ${toneClass(MODE_TONE[permission.mode])}`}
            style={{ color: 'var(--tone)' }}
            title={`${group?.label ?? permission.group}: ${permission.mode}`}
          >
            {group?.label ?? permission.group}: {permission.mode}
          </span>
        );
      })}
    </div>
  );
}
