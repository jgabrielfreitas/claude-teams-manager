import React, { useState } from 'react';
import { Box, Text } from 'ink';
import {
  APPROVAL_CATEGORIES,
  APPROVAL_CATEGORY_LABELS,
  type AppSettings,
  type Budget,
} from '@claude-team/domain';
import { EFFORT_UI, formatDuration, formatRelative } from '@claude-team/ui-shared';
import { toneColor, UI } from '../theme.js';
import { useKeys, useListNav, useLoader, windowOf } from '../lib/hooks.js';
import { useUi, type Ui } from '../store.js';
import { checkProvider } from '../actions.js';
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

const budgetPatch = (settings: AppSettings, patch: Partial<Budget>) => ({
  defaultBudget: { ...settings.defaultBudget, ...patch },
});

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

const ROWS: Row[] = [
  {
    id: 'defaultModel',
    label: 'Default model',
    value: (s) => s.defaultModel,
    help: 'Model given to a new agent when nothing else says otherwise.',
    edit: async (ui, s) => {
      const models = await ui.core.listModelsInUse();
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
      const models = await ui.core.listModelsInUse();
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
    id: 'autoApproveAll',
    label: 'Auto-approve everything',
    value: (s) => (s.autoApproveAll ? 'yes (dangerous)' : 'no'),
    help: 'When enabled, no approval prompt is ever raised.',
    edit: (ui, s) => editBoolean(ui, 'Auto-approve everything', s.autoApproveAll, 'autoApproveAll'),
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
    id: 'maxCostUsd',
    label: 'Budget · max cost',
    value: (s) => (s.defaultBudget.maxCostUsd !== undefined ? `$${s.defaultBudget.maxCostUsd}` : '—'),
    help: 'A run stops when it costs more than this.',
    edit: (ui, s) =>
      editNumber(ui, 'Max cost (USD)', s.defaultBudget.maxCostUsd, (v) => budgetPatch(s, { maxCostUsd: v })),
  },
  {
    id: 'maxTokens',
    label: 'Budget · max tokens',
    value: (s) => s.defaultBudget.maxTokens?.toLocaleString() ?? '—',
    help: 'A run stops after this many tokens.',
    edit: (ui, s) =>
      editNumber(ui, 'Max tokens', s.defaultBudget.maxTokens, (v) => budgetPatch(s, { maxTokens: v })),
  },
  {
    id: 'maxDurationMinutes',
    label: 'Budget · max minutes',
    value: (s) => s.defaultBudget.maxDurationMinutes?.toString() ?? '—',
    help: 'Wall-clock limit for a run.',
    edit: (ui, s) =>
      editNumber(ui, 'Max duration (minutes)', s.defaultBudget.maxDurationMinutes, (v) =>
        budgetPatch(s, { maxDurationMinutes: v }),
      ),
  },
  {
    id: 'maxAgentActivations',
    label: 'Budget · max activations',
    value: (s) => s.defaultBudget.maxAgentActivations?.toString() ?? '—',
    help: 'Circuit breaker on how many times agents may run.',
    edit: (ui, s) =>
      editNumber(ui, 'Max agent activations', s.defaultBudget.maxAgentActivations, (v) =>
        budgetPatch(s, { maxAgentActivations: v }),
      ),
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
        if (row) void row.edit(ui, settings);
      } else if (input === 'R') setEnvToken((token) => token + 1);
      else if (input === 'p') void checkProvider(ui);
      else if (input === 'X') {
        void (async () => {
          const ok = await ui.dialogs.confirm({
            title: 'Reset every setting to its default?',
            danger: true,
          });
          if (ok) await ui.guard(() => ui.core.resetSettings(), 'Settings reset.');
        })();
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
