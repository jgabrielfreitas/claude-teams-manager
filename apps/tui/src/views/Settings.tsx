import React, { useState } from 'react';
import { Box, Text } from 'ink';
import {
  APPROVAL_CATEGORIES,
  APPROVAL_CATEGORY_LABELS,
  ISOLATED_SETUP,
  describeBudget,
  isIsolatedSetup,
  sourceForSkillScope,
  unreachableSkills,
  type AppSettings,
  type ClaudeSettingSource,
} from '@claude-team/domain';
import { EFFORT_UI, formatDuration, formatRelative } from '@claude-team/ui-shared';
import { toneColor, UI } from '../theme.js';
import { useKeys, useListNav, useLoader, windowOf } from '../lib/hooks.js';
import { useUi, type Ui } from '../store.js';
import { checkProvider, editBudget } from '../actions.js';
import { TwoPane, type ViewProps } from '../components/Layout.js';
import {
  Dim,
  EmptyState,
  ErrorLine,
  Field,
  KeyHints,
  ListRow,
  Loading,
  MoreRow,
  SectionTitle,
} from '../components/ui.js';

type Row = {
  id: string;
  label: string;
  value: (settings: AppSettings) => string;
  help: string;
  edit: (ui: Ui, settings: AppSettings) => Promise<void>;
};

async function editNumber(
  ui: Ui,
  title: string,
  current: number | undefined,
  apply: (value: number) => unknown,
): Promise<void> {
  const raw = await ui.dialogs.text({ title, label: 'value', initial: current === undefined ? '' : String(current) });
  if (raw === undefined) return;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) {
    ui.notify('That is not a number.', 'warning');
    return;
  }
  await ui.guard(() => ui.core.updateSettings(apply(parsed)), 'Settings saved.');
}

async function editBoolean(ui: Ui, title: string, current: boolean, key: keyof AppSettings): Promise<void> {
  const value = await ui.dialogs.select({
    title,
    items: [
      { value: 'true', label: 'enabled', tone: 'success' },
      { value: 'false', label: 'disabled', tone: 'muted' },
    ],
    initialValue: String(current),
  });
  if (value === undefined) return;
  await ui.guard(() => ui.core.updateSettings({ [key]: value === 'true' }), 'Settings saved.');
}


/** One line saying what of this machine a run inherits. */
function describeLocalSetup(setup: AppSettings['localSetup']): string {
  if (isIsolatedSetup(setup)) return 'off — agents start from nothing';
  const parts: string[] = [];
  if (setup.settingSources.length) parts.push(`settings: ${setup.settingSources.join('+')}`);
  if (setup.skills === 'all') parts.push('all skills');
  else if (Array.isArray(setup.skills) && setup.skills.length) parts.push(`${setup.skills.length} skill(s)`);
  if (setup.mcpServers) parts.push('MCP servers');
  return `on — ${parts.join(', ')}`;
}


/**
 * Skills are only discovered through the setting source they live under, so
 * turning them on without it offers plugin skills and none of your own — with
 * nothing on screen to say why. Offering to fix it is better than a warning
 * nobody can act on.
 */
async function warnAboutUnreachableSkills(ui: Ui, setup: AppSettings['localSetup']): Promise<void> {
  const env = await ui.core.detectEnvironment().catch(() => undefined);
  const stranded = unreachableSkills(setup, env?.claude.skills ?? []);
  if (stranded.length === 0) return;

  const missing = [...new Set(stranded.map((skill) => sourceForSkillScope(skill.scope)))];
  const ok = await ui.dialogs.confirm({
    title: `${stranded.length} skill(s) cannot be reached`,
    message: `${stranded.slice(0, 4).map((s2) => s2.name).join(', ')} need "${missing.join('" and "')}" settings loaded before Claude Code finds them. Switch them on now?`,
  });
  if (!ok) return;
  await ui.guard(
    () =>
      ui.core.updateSettings({
        localSetup: { ...setup, settingSources: [...new Set([...setup.settingSources, ...missing])] },
      }),
    'Settings saved.',
  );
}

const ROWS: Row[] = [
  {
    id: 'defaultModel',
    label: 'Default model',
    value: (s) => s.defaultModel,
    help: 'Model given to a new agent when nothing else says otherwise.',
    edit: async (ui, s) => {
      const models = await ui.guard(() => ui.core.listModelsInUse());
      if (!models) return;
      const value = await ui.dialogs.select({
        title: 'Default model',
        items: models.map((m) => ({ value: m.id, label: m.label, hint: m.tier })),
        initialValue: s.defaultModel,
      });
      if (value) await ui.guard(() => ui.core.updateSettings({ defaultModel: value }), 'Settings saved.');
    },
  },
  {
    id: 'defaultOrchestratorModel',
    label: 'Orchestrator model',
    value: (s) => s.defaultOrchestratorModel,
    help: 'Suggested model for the agent that coordinates a team.',
    edit: async (ui, s) => {
      const models = await ui.guard(() => ui.core.listModelsInUse());
      if (!models) return;
      const value = await ui.dialogs.select({
        title: 'Orchestrator model',
        items: models.map((m) => ({ value: m.id, label: m.label, hint: m.tier })),
        initialValue: s.defaultOrchestratorModel,
      });
      if (value)
        await ui.guard(() => ui.core.updateSettings({ defaultOrchestratorModel: value }), 'Settings saved.');
    },
  },
  {
    id: 'defaultEffort',
    label: 'Default effort',
    value: (s) => EFFORT_UI[s.defaultEffort].label,
    help: 'Reasoning effort given to a new agent.',
    edit: async (ui, s) => {
      const value = await ui.dialogs.select({
        title: 'Default effort',
        items: ui.core.listEfforts().map((effort) => ({
          value: effort.id,
          label: `${EFFORT_UI[effort.id].bar} ${effort.label}`,
          hint: effort.description,
          tone: EFFORT_UI[effort.id].tone,
        })),
        initialValue: s.defaultEffort,
      });
      if (value) await ui.guard(() => ui.core.updateSettings({ defaultEffort: value }), 'Settings saved.');
    },
  },
  {
    id: 'defaultWorkspace',
    label: 'Default workspace',
    value: (s) => s.defaultWorkspace ?? '(current directory)',
    help: 'Suggested working directory for new teams.',
    edit: async (ui, s) => {
      const value = await ui.dialogs.text({
        title: 'Default workspace',
        label: 'path',
        initial: s.defaultWorkspace ?? process.cwd(),
        help: 'Empty clears it, so each team falls back to the current directory.',
      });
      if (value === undefined) return;
      await ui.guard(
        () => ui.core.updateSettings({ defaultWorkspace: value.trim() || null }),
        'Settings saved.',
      );
    },
  },
  {
    id: 'provider',
    label: 'Provider',
    value: (s) => s.provider,
    help: 'Engine used to execute agents. Takes effect on the next start.',
    edit: async (ui, s) => {
      const value = await ui.dialogs.select({
        title: 'Provider',
        items: ui.core.listProviders().map((provider) => ({
          value: provider.id,
          label: provider.label,
          hint: provider.current ? 'running now' : undefined,
          tone: provider.current ? 'success' : undefined,
        })),
        initialValue: s.provider,
        help: 'Applies the next time claude-team starts.',
      });
      if (!value) return;
      await ui.guard(() => ui.core.updateSettings({ provider: value }), 'Settings saved.');
    },
  },
  {
    id: 'autoMode',
    label: 'Auto mode',
    value: (s) =>
      s.autoApproveAll && s.autoAnswerQuestions
        ? 'ON — the run never stops to ask'
        : s.autoApproveAll || s.autoAnswerQuestions
          ? `partly on (${[
              s.autoApproveAll ? 'approvals' : undefined,
              s.autoAnswerQuestions ? 'questions' : undefined,
            ]
              .filter(Boolean)
              .join(' + ')})`
          : 'off — you are asked',
    help:
      'One switch for both gates below. On, the run never stops to ask: every permission is granted automatically, and an agent\'s question is answered with an instruction to decide for itself and state the assumption it made. Nothing waits for you, and nothing asks twice.',
    edit: async (ui, s) => {
      const value = await ui.dialogs.select({
        title: 'Auto mode',
        help: 'On: permissions granted automatically, questions answered with "decide it yourself and state the assumption".',
        items: [
          { value: 'true', label: 'ON — never stop to ask', tone: 'danger' },
          { value: 'false', label: 'off — ask me', tone: 'success' },
        ],
        initialValue: String(s.autoApproveAll && s.autoAnswerQuestions),
      });
      if (value === undefined) return;
      ui.setAutoMode(value === 'true');
    },
  },
  {
    id: 'autoApproveAll',
    label: '· grant permissions',
    value: (s) => (s.autoApproveAll ? 'yes (dangerous)' : 'no'),
    help: 'Half of auto mode, on its own: no approval prompt is ever raised. Leave the question switch off if you want permissions automatic but an agent\'s question still to reach you.',
    edit: (ui, s) => editBoolean(ui, 'Auto-approve everything', s.autoApproveAll, 'autoApproveAll'),
  },
  {
    id: 'autoAnswerQuestions',
    label: '· answer questions',
    value: (s) => (s.autoAnswerQuestions ? 'yes (agent decides alone)' : 'no (it waits for you)'),
    help: 'The other half of auto mode: an agent asking the human is told to decide for itself and state the assumption, instead of blocking until someone answers.',
    edit: (ui, s) =>
      editBoolean(ui, 'Auto-answer agent questions', s.autoAnswerQuestions, 'autoAnswerQuestions'),
  },
  {
    id: 'questionTimeoutMs',
    label: '· question timeout',
    value: (s) => formatDuration(s.questionTimeoutMs),
    help: 'How long a question waits for a human before it is answered automatically anyway (milliseconds). A blocked agent is never left waiting for ever.',
    edit: (ui, s) =>
      editNumber(ui, 'Question timeout (ms)', s.questionTimeoutMs, (v) => ({ questionTimeoutMs: v })),
  },
  {
    id: 'localSetup',
    label: 'Local Claude Code',
    value: (s) => describeLocalSetup(s.localSetup),
    help: "How much of this machine's own Claude Code setup agents inherit: your memory, your skills, your MCP servers. Your Claude login is used either way — this is about configuration, not credentials. Off keeps a team behaving the same on every machine.",
    edit: async (ui, s) => {
      const value = await ui.dialogs.select({
        title: 'Reuse this machine\'s Claude Code setup',
        help: 'On loads your user and workspace settings, every installed skill, and the MCP servers configured here.',
        items: [
          { value: 'true', label: 'on — inherit memory, skills and MCP', tone: 'warning' },
          { value: 'false', label: 'off — isolated, same on every machine', tone: 'success' },
        ],
        initialValue: String(!isIsolatedSetup(s.localSetup)),
      });
      if (value === undefined) return;
      const localSetup =
        value === 'true'
          ? { settingSources: ['user', 'project'] as ClaudeSettingSource[], skills: 'all' as const, mcpServers: true }
          : { ...ISOLATED_SETUP };
      await ui.guard(
        () => ui.core.updateSettings({ localSetup: { ...localSetup, ...(s.localSetup.executablePath ? { executablePath: s.localSetup.executablePath } : {}) } }),
        'Settings saved.',
      );
      if (value === 'true') {
        ui.notify('Your settings.json can pre-approve tools, which then run without asking.', 'warning');
      }
    },
  },
  {
    id: 'localSettingSources',
    label: '· settings & memory',
    value: (s) => (s.localSetup.settingSources.length ? s.localSetup.settingSources.join(', ') : 'none'),
    help: 'Which Claude Code setting files agents load. `project` is what brings in the CLAUDE.md of the agent\'s workspace; `user` brings in your own settings and memory, including any tool it pre-approves.',
    edit: async (ui, s) => {
      const selected = await ui.dialogs.multiselect({
        title: 'Settings files agents load',
        items: [
          { value: 'user', label: 'user — ~/.claude/settings.json and your memory' },
          { value: 'project', label: 'project — workspace settings and CLAUDE.md' },
          { value: 'local', label: 'local — .claude/settings.local.json' },
        ],
        selected: s.localSetup.settingSources,
      });
      if (!selected) return;
      await ui.guard(
        () =>
          ui.core.updateSettings({
            localSetup: { ...s.localSetup, settingSources: selected as ClaudeSettingSource[] },
          }),
        'Settings saved.',
      );
    },
  },
  {
    id: 'localSkills',
    label: '· skills',
    value: (s) =>
      s.localSetup.skills === 'all'
        ? 'all installed skills'
        : Array.isArray(s.localSetup.skills) && s.localSetup.skills.length
          ? s.localSetup.skills.join(', ')
          : 'none',
    help: 'Skills installed on this machine that agents may invoke. Choosing specific ones keeps an agent focused instead of handing it everything you have.',
    edit: async (ui, s) => {
      const mode = await ui.dialogs.select({
        title: 'Skills available to agents',
        items: [
          { value: 'none', label: 'none', tone: 'muted' },
          { value: 'all', label: 'all installed skills' },
          { value: 'pick', label: 'choose from the installed skills' },
        ],
        initialValue:
          s.localSetup.skills === 'all' ? 'all' : s.localSetup.skills === 'none' ? 'none' : 'pick',
      });
      if (mode === undefined) return;
      if (mode !== 'pick') {
        const next = { ...s.localSetup, skills: mode as 'all' | 'none' };
        await ui.guard(() => ui.core.updateSettings({ localSetup: next }), 'Settings saved.');
        await warnAboutUnreachableSkills(ui, next);
        return;
      }
      const env = await ui.guard(() => ui.core.detectEnvironment());
      const installed = env?.claude.skills ?? [];
      if (installed.length === 0) {
        ui.notify('No skills found under ~/.claude/skills or the workspace.', 'warning');
        return;
      }
      const selected = await ui.dialogs.multiselect({
        title: 'Skills available to agents',
        items: installed.map((skill) => ({ value: skill.name, label: skill.name, hint: skill.scope })),
        selected: Array.isArray(s.localSetup.skills) ? s.localSetup.skills : [],
      });
      if (!selected) return;
      const next = { ...s.localSetup, skills: selected };
      await ui.guard(() => ui.core.updateSettings({ localSetup: next }), 'Settings saved.');
      await warnAboutUnreachableSkills(ui, next);
    },
  },
  {
    id: 'localMcpServers',
    label: '· MCP servers',
    value: (s) => (s.localSetup.mcpServers ? 'reused from this machine' : 'none'),
    help: 'Reuse the MCP servers already configured here. Servers you logged into interactively may not connect from a background run; a stdio server started from a command always will.',
    edit: async (ui, s) => {
      const value = await ui.dialogs.select({
        title: 'MCP servers configured on this machine',
        items: [
          { value: 'true', label: 'reuse them' },
          { value: 'false', label: 'do not', tone: 'muted' },
        ],
        initialValue: String(s.localSetup.mcpServers),
      });
      if (value === undefined) return;
      await ui.guard(
        () => ui.core.updateSettings({ localSetup: { ...s.localSetup, mcpServers: value === 'true' } }),
        'Settings saved.',
      );
    },
  },
  {
    id: 'localExecutable',
    label: '· claude executable',
    value: (s) => s.localSetup.executablePath ?? 'bundled with the SDK',
    help: 'The `claude` binary to spawn. Empty uses the one the SDK ships with, which is pinned and therefore reproducible. Point it at your own install to run that version instead; applies the next time claude-team starts.',
    edit: async (ui, s) => {
      const raw = await ui.dialogs.text({
        title: 'Claude executable',
        label: 'path',
        initial: s.localSetup.executablePath ?? '',
      });
      if (raw === undefined) return;
      const executablePath = raw.trim();
      await ui.guard(
        () =>
          ui.core.updateSettings({
            localSetup: {
              ...s.localSetup,
              ...(executablePath ? { executablePath } : { executablePath: undefined }),
            },
          }),
        'Settings saved.',
      );
    },
  },
  {
    id: 'requireApprovalFor',
    label: 'Always ask for',
    value: (s) => (s.requireApprovalFor.length ? s.requireApprovalFor.join(', ') : 'nothing'),
    help: 'Categories that always need a human decision.',
    edit: async (ui, s) => {
      const selected = await ui.dialogs.multiselect({
        title: 'Always ask for',
        items: APPROVAL_CATEGORIES.map((category) => ({
          value: category,
          label: APPROVAL_CATEGORY_LABELS[category],
        })),
        selected: s.requireApprovalFor,
      });
      if (!selected) return;
      await ui.guard(() => ui.core.updateSettings({ requireApprovalFor: selected }), 'Settings saved.');
    },
  },
  {
    id: 'budget',
    label: 'Budget',
    value: (s) => describeBudget(s.defaultBudget),
    help: "What stops a run. A budget can be unmetered — no token cap and no money cap, for work that is worth whatever it costs — but it always keeps a way to stop: minutes, agent interactions, or both.",
    edit: (ui, s) =>
      editBudget(ui, s.defaultBudget, (defaultBudget) => ui.core.updateSettings({ defaultBudget })),
  },
  {
    id: 'maxHops',
    label: 'Max message hops',
    value: (s) => String(s.maxHops),
    help: 'How far an agent-to-agent message may travel before the bus refuses it.',
    edit: (ui, s) => editNumber(ui, 'Max hops', s.maxHops, (v) => ({ maxHops: v })),
  },
  {
    id: 'maxRecursionDepth',
    label: 'Max ask depth',
    value: (s) => String(s.maxRecursionDepth),
    help: 'Depth of nested synchronous questions between agents.',
    edit: (ui, s) => editNumber(ui, 'Max recursion depth', s.maxRecursionDepth, (v) => ({ maxRecursionDepth: v })),
  },
  {
    id: 'askTimeoutMs',
    label: 'Ask timeout',
    value: (s) => formatDuration(s.askTimeoutMs),
    help: 'How long an agent waits for an answer from a teammate (milliseconds).',
    edit: (ui, s) => editNumber(ui, 'Ask timeout (ms)', s.askTimeoutMs, (v) => ({ askTimeoutMs: v })),
  },
  {
    id: 'webPort',
    label: 'Web port',
    value: (s) => String(s.webPort),
    help: 'Port used by the web interface.',
    edit: (ui, s) => editNumber(ui, 'Web port', s.webPort, (v) => ({ webPort: v })),
  },
  {
    id: 'theme',
    label: 'Theme',
    value: (s) => s.theme,
    help: 'Colour scheme preference shared with the web UI.',
    edit: async (ui, s) => {
      const value = await ui.dialogs.select({
        title: 'Theme',
        items: [
          { value: 'auto', label: 'auto' },
          { value: 'dark', label: 'dark' },
          { value: 'light', label: 'light' },
        ],
        initialValue: s.theme,
      });
      if (value) await ui.guard(() => ui.core.updateSettings({ theme: value }), 'Settings saved.');
    },
  },
  {
    id: 'telemetry',
    label: 'Telemetry',
    value: (s) => (s.telemetry ? 'enabled' : 'disabled'),
    help: 'Anonymous usage reporting.',
    edit: (ui, s) => editBoolean(ui, 'Telemetry', s.telemetry, 'telemetry'),
  },
  {
    id: 'onboardingCompleted',
    label: 'Onboarding',
    value: (s) => (s.onboardingCompleted ? 'completed' : 'not completed'),
    help: 'Run the setup wizard again from the command palette (Run Onboarding Again).',
    edit: async (ui) => {
      const again = await ui.dialogs.confirm({ title: 'Run the onboarding wizard again?' });
      if (again) ui.setOnboarding(true);
    },
  },
];

export function SettingsView({ height, columns, narrow }: ViewProps): React.JSX.Element {
  const ui = useUi();
  const revision = ui.rev(['settings']);
  const [envToken, setEnvToken] = useState(0);

  const settingsState = useLoader(() => ui.core.getSettings(), [revision]);
  const envState = useLoader(
    async () => {
      const [environment, health] = await Promise.all([ui.core.detectEnvironment(), ui.core.checkProvider()]);
      return { environment, health };
    },
    [envToken],
  );

  const listActive = ui.lock === 'view' && ui.focus === 'list';
  const nav = useListNav(ROWS.length, listActive);
  const settings = settingsState.data;

  useKeys(
    (input, key) => {
      if ((key.return || input === 'e') && settings) {
        const row = ROWS[nav.index];
        if (row) ui.dispatch(() => row.edit(ui, settings));
      } else if (input === 'R') setEnvToken((token) => token + 1);
      else if (input === 'p') ui.dispatch(() => checkProvider(ui));
      else if (input === 'X') {
        ui.dispatch(async () => {
          const ok = await ui.dialogs.confirm({
            title: 'Reset every setting to its default?',
            danger: true,
          });
          if (ok) await ui.guard(() => ui.core.resetSettings(), 'Settings reset.');
        });
      }
    },
    ui.lock === 'view',
  );

  const rows = Math.max(3, height - 5);
  const { slice, offset } = windowOf(ROWS, nav.index, rows);

  const list = !settings ? (
    settingsState.error ? (
      <ErrorLine message={settingsState.error} />
    ) : (
      <Loading label="Loading settings" />
    )
  ) : (
    <Box flexDirection="column">
      {slice.map((row, index) => (
        <ListRow key={row.id} selected={offset + index === nav.index} focused={listActive}>
          <Box>
            <Box width={22} flexShrink={0}>
              <Text wrap="truncate-end">{row.label}</Text>
            </Box>
            <Box flexGrow={1} overflow="hidden">
              <Text color={UI.accent} wrap="truncate-end">
                {row.value(settings)}
              </Text>
            </Box>
          </Box>
        </ListRow>
      ))}
      <MoreRow count={ROWS.length - slice.length - offset} />
    </Box>
  );

  const row = ROWS[nav.index];
  const environment = envState.data?.environment;
  const health = envState.data?.health;

  const detail = !settings ? (
    <EmptyState title="Settings unavailable." />
  ) : (
    <Box flexDirection="column">
      <Text bold>{row?.label}</Text>
      <Dim>{row?.help}</Dim>
      <Box marginTop={1}>
        <Field label="current" value={row ? row.value(settings) : '—'} />
      </Box>
      <Field label="saved" value={formatRelative(settings.updatedAt)} />

      <SectionTitle>Storage</SectionTitle>
      {envState.loading && !environment ? (
        <Loading label="Inspecting environment" />
      ) : envState.error ? (
        <ErrorLine message={envState.error} />
      ) : environment ? (
        <Box flexDirection="column">
          <Field label="driver" value={environment.storage.driver} />
          <Field label="location" value={environment.storage.location} />
          <Field label="teams" value={String(environment.existingTeams)} />
          {narrow ? null : (
            <>
              <SectionTitle>Claude</SectionTitle>
              <Field
                label="cli"
                value={
                  environment.claude.cliInstalled
                    ? `${environment.claude.cliPath} ${environment.claude.cliVersion ?? ''}`
                    : 'not found on PATH'
                }
                tone={environment.claude.cliInstalled ? 'success' : 'warning'}
              />
              <Field
                label="auth"
                value={
                  environment.claude.authenticated
                    ? `authenticated (${environment.claude.authMethod})`
                    : 'not authenticated'
                }
                tone={environment.claude.authenticated ? 'success' : 'warning'}
              />
              <Field
                label="mcp"
                value={
                  environment.claude.mcpServers.length
                    ? environment.claude.mcpServers.map((server) => server.name).join(', ')
                    : 'none configured'
                }
              />
              <Field
                label="skills"
                value={
                  environment.claude.skills.length
                    ? environment.claude.skills.map((skill) => skill.name).join(', ')
                    : 'none installed'
                }
              />
              <Field
                label="tools"
                value={environment.claude.availableTools.join(', ') || '—'}
              />
            </>
          )}
        </Box>
      ) : null}

      <SectionTitle>Provider health</SectionTitle>
      {health ? (
        <Text color={toneColor(health.ok ? 'success' : 'danger')} wrap="truncate-end">
          {health.ok ? '✓' : '✗'} {health.detail}
        </Text>
      ) : (
        <Dim>checking…</Dim>
      )}

      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↵', label: 'edit' },
            { key: 'R', label: 'refresh environment' },
            { key: 'p', label: 'check provider' },
            { key: 'X', label: 'reset all' },
          ]}
        />
      </Box>
    </Box>
  );

  return (
    <TwoPane
      listTitle="Settings"
      listSubtitle={`${ROWS.length}`}
      detailTitle="Detail"
      detailSubtitle={ui.providerId}
      list={list}
      detail={detail}
      columns={columns}
      narrow={narrow}
      ratio={0.44}
    />
  );
}
