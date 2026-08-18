import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { shortModelLabel, type Agent, type TeamWithAgents } from '@claude-team/domain';
import { EFFORT_UI, truncate } from '@claude-team/ui-shared';
import { toneColor, UI } from '../theme.js';
import type { AppCore } from '@claude-team/core';
import { useKeys, useListNav, useLoader, type LoaderState } from '../lib/hooks.js';
import { useUi } from '../store.js';
import { Dim, ErrorLine, Field, KeyHints, ListRow, Loading, SectionTitle } from '../components/ui.js';
import { CapabilityChips } from '../components/rows.js';

/**
 * First-run wizard.
 *
 * Rule: never ask for anything the core can detect. Everything shown here comes
 * from `core.detectEnvironment()`, `core.checkProvider()` and
 * `core.inspectWorkspace()`; the questions left are genuinely choices.
 */

const STEPS = [
  'Welcome',
  'Claude',
  'Workspace',
  'Team',
  'Models & effort',
  'Permissions',
  'First task',
] as const;

export function Onboarding({ columns }: { columns: number; height: number }): React.JSX.Element {
  const ui = useUi();
  const [step, setStep] = useState(0);
  const [workspace, setWorkspace] = useState(process.cwd());
  const [team, setTeam] = useState<TeamWithAgents | undefined>();

  // Depends on `workspace`: changing the directory at step 3 must re-detect,
  // or the git information shown for it would still describe the old one.
  const environment = useLoader(async () => {
    const [detected, health] = await Promise.all([
      ui.core.detectEnvironment(workspace),
      ui.core.checkProvider(),
    ]);
    return { detected, health };
  }, [workspace, ui.core]);

  const finish = async () => {
    await ui.guard(() => ui.core.completeOnboarding());
    ui.setOnboarding(false);
    ui.setSection(team ? 'teams' : 'dashboard');
  };

  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  useKeys(
    (input, key) => {
      if (input === 's') ui.dispatch(finish);
      else if (key.leftArrow || input === 'b') back();
    },
    ui.lock === 'view',
  );

  const active = ui.lock === 'view';

  const body = (() => {
    switch (step) {
      case 0:
        return <Welcome environment={environment} onNext={next} active={active} />;
      case 1:
        return <ClaudeStep environment={environment} onNext={next} active={active} />;
      case 2:
        return (
          <WorkspaceStep
            workspace={workspace}
            setWorkspace={setWorkspace}
            onNext={next}
            active={active}
          />
        );
      case 3:
        return (
          <TeamStep
            workspace={workspace}
            team={team}
            setTeam={setTeam}
            onNext={next}
            active={active}
          />
        );
      case 4:
        return <ModelsStep team={team} setTeam={setTeam} onNext={next} active={active} />;
      case 5:
        return <PermissionsStep team={team} setTeam={setTeam} onNext={next} active={active} />;
      default:
        return <ObjectiveStep team={team} onDone={finish} active={active} />;
    }
  })();

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={UI.accent} paddingX={1}>
      <Box>
        <Text bold color={UI.accent}>
          Welcome to claude-team{'  '}
        </Text>
        <Text color={UI.dim}>
          step {step + 1}/{STEPS.length} · {STEPS[step]}
        </Text>
      </Box>
      <Box>
        <Text>
          {STEPS.map((label, index) => (
            <Text key={label} color={index <= step ? toneColor('active') : UI.dim}>
              {index <= step ? '━' : '─'}
              {columns > 70 ? '' : ''}
            </Text>
          ))}
          <Text color={UI.dim}>{'  '}</Text>
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {body}
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↵', label: 'continue' },
            { key: 'b', label: 'back' },
            { key: 's', label: 'skip setup' },
          ]}
        />
      </Box>
    </Box>
  );
}

type EnvironmentState = LoaderState<{
  detected: Awaited<ReturnType<AppCore['detectEnvironment']>>;
  health: Awaited<ReturnType<AppCore['checkProvider']>>;
}>;

function Welcome({
  environment,
  onNext,
  active,
}: {
  environment: EnvironmentState;
  onNext: () => void;
  active: boolean;
}): React.JSX.Element {
  useKeys((_input, key) => {
    if (key.return) onNext();
  }, active);

  const detected = environment.data?.detected;

  return (
    <Box flexDirection="column">
      <Text>Teams of Claude agents that plan, delegate and talk to each other.</Text>
      <Dim>Everything below was detected automatically. You only answer what cannot be inferred.</Dim>
      <SectionTitle>Detected</SectionTitle>
      {environment.loading && !detected ? (
        <Loading label="Looking around" />
      ) : environment.error ? (
        <ErrorLine message={environment.error} />
      ) : detected ? (
        <Box flexDirection="column">
          <Field
            label="claude cli"
            value={
              detected.claude.cliInstalled
                ? `${detected.claude.cliVersion ?? 'installed'}`
                : 'not found on PATH'
            }
            tone={detected.claude.cliInstalled ? 'success' : 'warning'}
          />
          <Field
            label="auth"
            value={detected.claude.authenticated ? detected.claude.authMethod : 'not authenticated'}
            tone={detected.claude.authenticated ? 'success' : 'warning'}
          />
          <Field label="directory" value={detected.workspace.path} />
          <Field
            label="git"
            value={
              detected.workspace.git.isRepo
                ? `${detected.workspace.git.branch ?? 'detached'} · ${detected.workspace.git.dirtyFiles} dirty`
                : 'not a git repository'
            }
          />
          <Field label="storage" value={`${detected.storage.driver} · ${detected.storage.location}`} />
          <Field label="teams" value={`${detected.existingTeams} already stored`} />
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={UI.accent}>Press ↵ to begin.</Text>
      </Box>
    </Box>
  );
}

function ClaudeStep({
  environment,
  onNext,
  active,
}: {
  environment: EnvironmentState;
  onNext: () => void;
  active: boolean;
}): React.JSX.Element {
  useKeys((_input, key) => {
    if (key.return) onNext();
  }, active);

  const detected = environment.data?.detected;
  const health = environment.data?.health;

  return (
    <Box flexDirection="column">
      <Text bold>How agents will run</Text>
      {!detected ? (
        <Loading />
      ) : (
        <Box flexDirection="column">
          <Field
            label="cli path"
            value={detected.claude.cliPath ?? 'not found'}
            tone={detected.claude.cliInstalled ? 'success' : 'warning'}
          />
          <Field label="version" value={detected.claude.cliVersion ?? '—'} />
          <Field label="sdk" value={detected.claude.sdkInstalled ? 'installed' : 'not installed'} />
          <Field
            label="mcp servers"
            value={
              detected.claude.mcpServers.length
                ? detected.claude.mcpServers.map((s) => `${s.name} (${s.scope})`).join(', ')
                : 'none configured'
            }
          />
          <Field
            label="skills"
            value={
              detected.claude.skills.length
                ? `${detected.claude.skills.length} installed: ${detected.claude.skills.map((s) => s.name).join(', ')}`
                : 'none installed'
            }
          />
          <Field label="tools" value={detected.claude.availableTools.join(', ') || '—'} />
          {health ? (
            <Field
              label="provider"
              value={health.detail}
              tone={health.ok ? 'success' : 'danger'}
            />
          ) : null}
          {!detected.claude.authenticated ? (
            <Box marginTop={1} flexDirection="column">
              <Text color={toneColor('warning')}>
                No credentials found. Run `claude` once to log in, or set ANTHROPIC_API_KEY.
              </Text>
              <Dim>You can still set everything up now and run agents later.</Dim>
            </Box>
          ) : null}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={UI.accent}>↵ continue</Text>
      </Box>
    </Box>
  );
}

function WorkspaceStep({
  workspace,
  setWorkspace,
  onNext,
  active,
}: {
  workspace: string;
  setWorkspace: (path: string) => void;
  onNext: () => void;
  active: boolean;
}): React.JSX.Element {
  const ui = useUi();
  const info = useLoader(() => ui.core.inspectWorkspace(workspace), [workspace]);

  useKeys(
    (input, key) => {
      if (key.return) {
        ui.dispatch(() => ui.guard(() => ui.core.updateSettings({ defaultWorkspace: workspace })));
        onNext();
      } else if (input === 'e') {
        ui.dispatch(async () => {
          const value = await ui.dialogs.text({
            title: 'Workspace',
            label: 'path',
            initial: workspace,
            help: 'Agents read and write inside this directory.',
          });
          if (value?.trim()) setWorkspace(value.trim());
        });
      }
    },
    active,
  );

  return (
    <Box flexDirection="column">
      <Text bold>Where should the agents work?</Text>
      <Dim>Defaults to the directory you started from.</Dim>
      <Box marginTop={1} flexDirection="column">
        <Field label="path" value={info.data?.path ?? workspace} />
        {info.error ? (
          <ErrorLine message={info.error} />
        ) : info.data ? (
          <>
            <Field
              label="exists"
              value={info.data.exists ? 'yes' : 'no — it will be created by the tools you run'}
              tone={info.data.exists ? 'success' : 'warning'}
            />
            <Field label="git" value={info.data.summary ?? 'not a git repository'} />
            {info.data.git.remote ? <Field label="remote" value={info.data.git.remote} /> : null}
          </>
        ) : (
          <Loading />
        )}
      </Box>
      <Box marginTop={1}>
        <KeyHints hints={[{ key: 'e', label: 'change directory' }, { key: '↵', label: 'use this one' }]} />
      </Box>
    </Box>
  );
}

function TeamStep({
  workspace,
  team,
  setTeam,
  onNext,
  active,
}: {
  workspace: string;
  team?: TeamWithAgents;
  setTeam: (team: TeamWithAgents) => void;
  onNext: () => void;
  active: boolean;
}): React.JSX.Element {
  const ui = useUi();
  const presets = ui.core.listPresets();
  const nav = useListNav(presets.length, active && !team);

  useKeys(
    (_input, key) => {
      if (!key.return) return;
      if (team) {
        onNext();
        return;
      }
      const preset = presets[nav.index];
      if (!preset) return;
      ui.dispatch(async () => {
        const created = await ui.guard(
          () => ui.core.createTeamFromPreset({ presetId: preset.id, workspace }),
          `Created "${preset.name}".`,
        );
        if (created) {
          setTeam(created);
          ui.select({ teamId: created.id });
          onNext();
        }
      });
    },
    active,
  );

  if (team) {
    return (
      <Box flexDirection="column">
        <Text bold>{team.name} is ready.</Text>
        <Dim>{team.description}</Dim>
        <Box marginTop={1}>
          <Text color={UI.accent}>↵ continue</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Pick a starting team</Text>
      <Dim>Every agent, prompt, model and capability stays editable afterwards.</Dim>
      <Box marginTop={1} flexDirection="column">
        {presets.map((preset, index) => (
          <ListRow key={preset.id} selected={index === nav.index} focused>
            <Box flexDirection="column">
              <Text bold={index === nav.index}>
                {preset.name}
                <Text color={UI.dim}>{`  ${preset.members.length} agents`}</Text>
              </Text>
              {index === nav.index ? <Dim>{preset.description}</Dim> : null}
            </Box>
          </ListRow>
        ))}
      </Box>
    </Box>
  );
}

function ModelsStep({
  team,
  setTeam,
  onNext,
  active,
}: {
  team?: TeamWithAgents;
  setTeam: (team: TeamWithAgents) => void;
  onNext: () => void;
  active: boolean;
}): React.JSX.Element {
  const ui = useUi();
  const agents = team?.agents ?? [];
  const nav = useListNav(agents.length, active);

  const refresh = async () => {
    if (!team) return;
    const updated = await ui.guard(() => ui.core.getTeam(team.id));
    if (updated) setTeam(updated);
  };

  useKeys(
    (input, key) => {
      const agent = agents[nav.index];
      if (key.return) {
        onNext();
        return;
      }
      if (!agent) return;
      if (input === 'm') {
        ui.dispatch(async () => {
          const models = await ui.guard(() => ui.core.listModelsInUse());
          if (!models) return;
          const value = await ui.dialogs.select({
            title: `Model · ${agent.handle}`,
            items: models.map((model) => ({ value: model.id, label: model.label, hint: model.tier })),
            help: 'This choice applies to this agent alone.',
          });
          if (value) {
            await ui.guard(() => ui.core.updateAgentModel(agent.id, value));
            await refresh();
          }
        });
      } else if (input === 'e') {
        ui.dispatch(async () => {
          const value = await ui.dialogs.select({
            title: `Effort · ${agent.handle}`,
            items: ui.core.listEfforts().map((effort) => ({
              value: effort.id,
              label: `${EFFORT_UI[effort.id].bar} ${effort.label}`,
              hint: effort.description,
              tone: EFFORT_UI[effort.id].tone,
            })),
          });
          if (value) {
            await ui.guard(() => ui.core.updateAgentEffort(agent.id, value as Agent['effort']));
            await refresh();
          }
        });
      }
    },
    active,
  );

  return (
    <Box flexDirection="column">
      <Text bold>Confirm each agent&apos;s model and effort</Text>
      <Dim>Every agent runs with its own settings — nothing is inherited at run time.</Dim>
      <Box marginTop={1} flexDirection="column">
        {agents.map((agent, index) => (
          <ListRow key={agent.id} selected={index === nav.index} focused>
            <Box>
              <Box width={14} flexShrink={0}>
                <Text>{agent.handle}</Text>
              </Box>
              <Box width={22} flexShrink={1}>
                <Text color={UI.dim} wrap="truncate-end">
                  {agent.role}
                </Text>
              </Box>
              <Box width={10} flexShrink={0}>
                <Text>{shortModelLabel(agent.model)}</Text>
              </Box>
              <Text color={toneColor(EFFORT_UI[agent.effort].tone)}>
                {EFFORT_UI[agent.effort].bar} {EFFORT_UI[agent.effort].label}
              </Text>
            </Box>
          </ListRow>
        ))}
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'm', label: 'model' },
            { key: 'e', label: 'effort' },
            { key: '↵', label: 'continue' },
          ]}
        />
      </Box>
    </Box>
  );
}

function PermissionsStep({
  team,
  setTeam,
  onNext,
  active,
}: {
  team?: TeamWithAgents;
  setTeam: (team: TeamWithAgents) => void;
  onNext: () => void;
  active: boolean;
}): React.JSX.Element {
  const ui = useUi();
  const agents = team?.agents ?? [];
  const groups = ui.core.listToolGroups();
  const nav = useListNav(agents.length, active);

  useKeys(
    (input, key) => {
      if (key.return) {
        onNext();
        return;
      }
      const agent = agents[nav.index];
      if (!agent || input !== 'p') return;
      ui.dispatch(async () => {
        const tools = await ui.dialogs.permissions({
          title: `Capabilities · ${agent.handle}`,
          permissions: agent.tools,
          groups,
        });
        if (!tools) return;
        await ui.guard(() => ui.core.updateAgentTools(agent.id, tools));
        if (team) {
          const updated = await ui.guard(() => ui.core.getTeam(team.id));
          if (updated) setTeam(updated);
        }
      });
    },
    active,
  );

  return (
    <Box flexDirection="column">
      <Text bold>What each agent is allowed to do</Text>
      <Dim>ask = you get a prompt before it happens. Sensitive capabilities default to ask.</Dim>
      <Box marginTop={1} flexDirection="column">
        {agents.map((agent, index) => (
          <ListRow key={agent.id} selected={index === nav.index} focused>
            <Box>
              <Box width={14} flexShrink={0}>
                <Text>{agent.handle}</Text>
              </Box>
              <CapabilityChips tools={agent.tools} groups={groups} width={20} />
            </Box>
          </ListRow>
        ))}
      </Box>
      <Box marginTop={1}>
        <KeyHints hints={[{ key: 'p', label: 'edit permissions' }, { key: '↵', label: 'continue' }]} />
      </Box>
    </Box>
  );
}

function ObjectiveStep({
  team,
  onDone,
  active,
}: {
  team?: TeamWithAgents;
  onDone: () => Promise<void>;
  active: boolean;
}): React.JSX.Element {
  const ui = useUi();

  useKeys(
    (input, key) => {
      if (input === 'n') {
        ui.dispatch(onDone);
        return;
      }
      if (!key.return) return;
      if (!team) {
        ui.dispatch(onDone);
        return;
      }
      ui.dispatch(async () => {
        const objective = await ui.dialogs.text({
          title: `First task for ${team.name}`,
          label: 'objective',
          placeholder: 'Review this repository and tell me what it does',
        });
        if (objective?.trim()) {
          const run = await ui.guard(
            () => ui.core.startRun({ teamId: team.id, objective }),
            'Run started.',
          );
          if (run) {
            ui.select({ runId: run.id, teamId: team.id });
            await ui.guard(() => ui.core.completeOnboarding());
            ui.setOnboarding(false);
            ui.setSection('runs');
            return;
          }
        }
        await onDone();
      });
    },
    active,
  );

  return (
    <Box flexDirection="column">
      <Text bold>Give the team something to do</Text>
      <Dim>Optional — you can always start a run later with r.</Dim>
      {team ? (
        <Box marginTop={1} flexDirection="column">
          <Field label="team" value={team.name} />
          <Field label="agents" value={team.agents.map((a) => a.handle).join(', ')} />
          <Field
            label="orchestrator"
            value={truncate(
              team.agents.find((a) => a.id === team.orchestratorId)?.handle ?? '—',
              30,
            )}
          />
        </Box>
      ) : (
        <Dim>No team was created — you can create one from the Teams section.</Dim>
      )}
      <Box marginTop={1}>
        <KeyHints hints={[{ key: '↵', label: 'type an objective' }, { key: 'n', label: 'finish without a run' }]} />
      </Box>
    </Box>
  );
}
