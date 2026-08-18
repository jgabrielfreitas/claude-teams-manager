import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  availableRunActions,
  shortModelLabel,
  slugify,
  type Agent,
  type Run,
  type TeamWithAgents,
} from '@claude-team/domain';
import { EFFORT_UI, RUN_STATUS_UI, truncate, type SectionId } from '@claude-team/ui-shared';
import { copyToClipboard } from './lib/clipboard.js';
import type { SelectItem, Ui } from './store.js';

/**
 * Every command the palette and the single-key shortcuts can run.
 *
 * These functions collect input through dialogs and then call `AppCore`. They
 * contain no rules of their own: what is legal comes from the domain
 * (`availableRunActions`) or from the core rejecting the call.
 */

/* ------------------------------------------------------------------ *
 * Pickers
 * ------------------------------------------------------------------ */

export async function pickTeam(ui: Ui, title = 'Select a team'): Promise<TeamWithAgents | undefined> {
  // Reads go through `guard` too: a storage failure is a status line, never a
  // rejection escaping into a key handler.
  const teams = await ui.guard(() => ui.core.listTeams());
  if (!teams) return undefined;
  if (teams.length === 0) {
    ui.notify('No teams yet — press c to create one.', 'warning');
    return undefined;
  }
  const value = await ui.dialogs.select({
    title,
    items: teams.map((team) => ({
      value: team.id,
      label: team.name,
      hint: `${team.agents.length} agent(s)`,
    })),
  });
  return teams.find((team) => team.id === value);
}

/** The selected team, asking for one only when nothing is selected. */
export async function currentTeam(ui: Ui): Promise<TeamWithAgents | undefined> {
  if (ui.selection.teamId) {
    try {
      return await ui.core.getTeam(ui.selection.teamId);
    } catch {
      /* falls through to the picker */
    }
  }
  const team = await pickTeam(ui);
  if (team) ui.select({ teamId: team.id });
  return team;
}

export async function currentAgent(ui: Ui): Promise<Agent | undefined> {
  if (ui.selection.agentId) {
    try {
      return await ui.core.getAgent(ui.selection.agentId);
    } catch {
      /* falls through */
    }
  }
  const team = await currentTeam(ui);
  if (!team) return undefined;
  const agent = await pickAgent(ui, team);
  if (agent) ui.select({ agentId: agent.id, teamId: agent.teamId });
  return agent;
}

export async function pickAgent(
  ui: Ui,
  team: TeamWithAgents,
  title = 'Select an agent',
): Promise<Agent | undefined> {
  if (team.agents.length === 0) {
    ui.notify(`"${team.name}" has no agents yet — press a to add one.`, 'warning');
    return undefined;
  }
  const value = await ui.dialogs.select({
    title,
    items: team.agents.map((agent) => ({
      value: agent.id,
      label: `${agent.handle}  ${agent.role}`,
      hint: `${shortModelLabel(agent.model)} · ${EFFORT_UI[agent.effort].label}`,
    })),
  });
  return team.agents.find((agent) => agent.id === value);
}

export async function currentRun(ui: Ui): Promise<Run | undefined> {
  if (ui.selection.runId) {
    try {
      return await ui.core.getRun(ui.selection.runId);
    } catch {
      /* falls through */
    }
  }
  return pickRun(ui);
}

export async function pickRun(ui: Ui, teamId?: string): Promise<Run | undefined> {
  const runs = await ui.guard(() => ui.core.listRuns({ teamId, limit: 50 }));
  if (!runs) return undefined;
  if (runs.length === 0) {
    ui.notify('No runs yet — press r on a team to start one.', 'warning');
    return undefined;
  }
  const value = await ui.dialogs.select({
    title: 'Select a run',
    items: runs.map((run) => ({
      value: run.id,
      label: truncate(run.objective, 56),
      hint: RUN_STATUS_UI[run.status].label,
      tone: RUN_STATUS_UI[run.status].tone,
    })),
  });
  const run = runs.find((r) => r.id === value);
  if (run) ui.select({ runId: run.id, teamId: run.teamId });
  return run;
}

async function pickModel(ui: Ui, current?: string): Promise<string | undefined> {
  const models = await ui.guard(() => ui.core.listModelsInUse());
  if (!models) return undefined;
  const items: SelectItem[] = models.map((model) => ({
    value: model.id,
    label: model.label,
    hint: [model.tier, model.id === current ? 'current' : undefined].filter(Boolean).join(' · '),
  }));
  items.push({ value: '__custom__', label: 'Type a model id…', hint: 'any provider model' });
  const value = await ui.dialogs.select({ title: 'Model', items, help: 'Applies to this agent only.' });
  if (value !== '__custom__') return value;
  const typed = await ui.dialogs.text({ title: 'Model id', initial: current ?? '', label: 'model' });
  return typed?.trim() || undefined;
}

async function pickEffort(ui: Ui, current?: string): Promise<string | undefined> {
  const efforts = ui.core.listEfforts();
  return ui.dialogs.select({
    title: 'Reasoning effort',
    help: 'Applies to this agent only.',
    items: efforts.map((effort) => ({
      value: effort.id,
      label: `${EFFORT_UI[effort.id].bar} ${effort.label}${effort.id === current ? '  (current)' : ''}`,
      hint: effort.description,
      tone: EFFORT_UI[effort.id].tone,
    })),
  });
}

/* ------------------------------------------------------------------ *
 * Teams
 * ------------------------------------------------------------------ */

export async function createTeam(ui: Ui): Promise<void> {
  const how = await ui.dialogs.select({
    title: 'Create a team',
    items: [
      { value: 'preset', label: 'From a preset', hint: 'a ready-made roster' },
      { value: 'blank', label: 'Blank team', hint: 'add agents yourself' },
      { value: 'import', label: 'Import from YAML…' },
    ],
  });
  if (how === 'preset') return createTeamFromPreset(ui);
  if (how === 'import') return importTeam(ui);
  if (how !== 'blank') return;

  const name = await ui.dialogs.text({ title: 'New team', label: 'name', placeholder: 'Platform Team' });
  if (!name?.trim()) return;
  const settings = await ui.core.getSettings();
  const workspace = await ui.dialogs.text({
    title: 'Workspace',
    label: 'path',
    initial: settings.defaultWorkspace ?? process.cwd(),
    help: 'Directory the agents work in. Leave as-is to accept it.',
  });
  const team = await ui.guard(
    () => ui.core.createTeam({ name, workspace: workspace?.trim() || undefined }),
    `Created team "${name.trim()}".`,
  );
  if (team) {
    ui.select({ teamId: team.id });
    ui.setSection('teams');
  }
}

export async function createTeamFromPreset(ui: Ui): Promise<void> {
  const presets = ui.core.listPresets();
  const presetId = await ui.dialogs.select({
    title: 'Team preset',
    items: presets.map((preset) => ({
      value: preset.id,
      label: preset.name,
      hint: `${preset.members.length} agents`,
    })),
    help: 'Every agent is fully editable afterwards.',
  });
  if (!presetId) return;
  const preset = presets.find((p) => p.id === presetId);
  const name = await ui.dialogs.text({
    title: 'Team name',
    label: 'name',
    initial: preset?.name ?? '',
  });
  if (name === undefined) return;
  const team = await ui.guard(
    () => ui.core.createTeamFromPreset({ presetId, name: name.trim() || undefined }),
    'Team created.',
  );
  if (team) {
    ui.select({ teamId: team.id });
    ui.setSection('teams');
  }
}

export async function editTeam(ui: Ui): Promise<void> {
  const team = await currentTeam(ui);
  if (!team) return;
  const field = await ui.dialogs.select({
    title: `Edit ${team.name}`,
    items: [
      { value: 'name', label: 'Name', hint: team.name },
      { value: 'description', label: 'Description', hint: truncate(team.description ?? '—', 40) },
      { value: 'workspace', label: 'Workspace', hint: team.workspace ?? '—' },
      { value: 'orchestrator', label: 'Orchestrator', hint: handleOf(team, team.orchestratorId) },
      { value: 'defaultAgent', label: 'Default agent', hint: handleOf(team, team.defaultAgentId) },
    ],
  });
  if (!field) return;

  if (field === 'orchestrator' || field === 'defaultAgent') {
    const agent = await pickAgent(ui, team, field === 'orchestrator' ? 'Orchestrator' : 'Default agent');
    if (!agent) return;
    await ui.guard(
      () =>
        ui.core.updateTeam(
          team.id,
          field === 'orchestrator' ? { orchestratorId: agent.id } : { defaultAgentId: agent.id },
        ),
      `${agent.handle} is now the ${field === 'orchestrator' ? 'orchestrator' : 'default agent'}.`,
    );
    return;
  }

  const initial =
    field === 'name' ? team.name : field === 'description' ? (team.description ?? '') : (team.workspace ?? '');
  const value = await ui.dialogs.text({ title: `Team ${field}`, label: field, initial });
  if (value === undefined) return;
  await ui.guard(() => ui.core.updateTeam(team.id, { [field]: value.trim() || null }), 'Team updated.');
}

export async function duplicateTeam(ui: Ui): Promise<void> {
  const team = await currentTeam(ui);
  if (!team) return;
  const name = await ui.dialogs.text({
    title: 'Duplicate team',
    label: 'name',
    initial: `${team.name} (copy)`,
  });
  if (name === undefined) return;
  const copy = await ui.guard(() => ui.core.duplicateTeam(team.id, name), 'Team duplicated.');
  if (copy) ui.select({ teamId: copy.id });
}

export async function deleteTeam(ui: Ui): Promise<void> {
  const team = await currentTeam(ui);
  if (!team) return;
  const ok = await ui.dialogs.confirm({
    title: `Delete "${team.name}"?`,
    message: `${team.agents.length} agent(s) and every run of this team will be removed.`,
    danger: true,
  });
  if (!ok) return;
  const done = await ui.guard(() => ui.core.deleteTeam(team.id), 'Team deleted.');
  if (done !== undefined) ui.select({ teamId: undefined, agentId: undefined });
}

export async function exportTeam(ui: Ui): Promise<void> {
  const team = await currentTeam(ui);
  if (!team) return;
  const yaml = await ui.guard(() => ui.core.exportTeam(team.id));
  if (!yaml) return;
  const path = await ui.dialogs.text({
    title: 'Export team as YAML',
    label: 'file',
    initial: resolve(process.cwd(), `${slugify(team.name) || 'team'}.team.yaml`),
    help: 'Empty path: show the YAML here instead of writing a file.',
  });
  if (path === undefined) return;
  if (!path.trim()) {
    await ui.dialogs.info({ title: `${team.name} (YAML)`, lines: yaml.split('\n').slice(0, 40) });
    return;
  }
  await ui.guard(async () => {
    await writeFile(resolve(path.trim()), yaml, 'utf8');
  }, `Written to ${resolve(path.trim())}`);
}

export async function importTeam(ui: Ui): Promise<void> {
  const path = await ui.dialogs.text({
    title: 'Import team from YAML',
    label: 'file',
    placeholder: './team.yaml',
  });
  if (!path?.trim()) return;
  const result = await ui.guard(async () => {
    const text = await readFile(resolve(path.trim()), 'utf8');
    return ui.core.importTeam(text);
  }, 'Team imported.');
  if (!result) return;
  ui.select({ teamId: result.team.id });
  ui.setSection('teams');
  if (result.warnings.length > 0) {
    await ui.dialogs.info({ title: 'Imported with warnings', lines: result.warnings });
  }
}

export async function setOrchestrator(ui: Ui): Promise<void> {
  const team = await currentTeam(ui);
  if (!team) return;
  const agent = await pickAgent(ui, team, 'Select orchestrator');
  if (!agent) return;
  await ui.guard(
    () => ui.core.updateTeam(team.id, { orchestratorId: agent.id }),
    `${agent.handle} orchestrates ${team.name}.`,
  );
}

function handleOf(team: TeamWithAgents, agentId?: string): string {
  return team.agents.find((agent) => agent.id === agentId)?.handle ?? '—';
}

/* ------------------------------------------------------------------ *
 * Agents
 * ------------------------------------------------------------------ */

export async function createAgent(ui: Ui): Promise<void> {
  const team = await currentTeam(ui);
  if (!team) return;
  const how = await ui.dialogs.select({
    title: `Add an agent to ${team.name}`,
    items: [
      { value: 'template', label: 'From a template', hint: 'prompt and capabilities included' },
      { value: 'blank', label: 'Blank agent' },
    ],
  });
  if (how === 'template') return createAgentFromTemplate(ui, team);
  if (how !== 'blank') return;

  const name = await ui.dialogs.text({ title: 'New agent', label: 'name', placeholder: 'Backend Engineer' });
  if (!name?.trim()) return;
  const role = await ui.dialogs.text({ title: 'Role', label: 'role', initial: name.trim() });
  if (!role?.trim()) return;
  const agent = await ui.guard(
    () => ui.core.createAgent({ teamId: team.id, name, role }),
    `Added ${name.trim()}.`,
  );
  if (agent) ui.select({ agentId: agent.id, teamId: team.id });
}

export async function createAgentFromTemplate(ui: Ui, team?: TeamWithAgents): Promise<void> {
  const target = team ?? (await currentTeam(ui));
  if (!target) return;
  const templates = ui.core.listTemplates();
  const templateId = await ui.dialogs.select({
    title: 'Agent template',
    items: templates.map((template) => ({
      value: template.id,
      label: `${template.name}  ${template.role}`,
      hint: `${template.category} · ${shortModelLabel(template.model)}/${template.effort}`,
    })),
  });
  if (!templateId) return;
  const agent = await ui.guard(
    () => ui.core.createAgentFromTemplate({ teamId: target.id, templateId }),
    'Agent added.',
  );
  if (agent) ui.select({ agentId: agent.id, teamId: target.id });
}

export async function editAgent(ui: Ui): Promise<void> {
  const agent = await currentAgent(ui);
  if (!agent) return;
  const field = await ui.dialogs.select({
    title: `Edit ${agent.handle}`,
    items: [
      { value: 'name', label: 'Name', hint: agent.name },
      { value: 'handle', label: 'Handle', hint: agent.handle },
      { value: 'role', label: 'Role', hint: agent.role },
      { value: 'description', label: 'Description', hint: truncate(agent.description ?? '—', 40) },
      { value: 'systemPrompt', label: 'System prompt', hint: truncate(agent.systemPrompt, 40) },
      { value: 'context', label: 'Extra context', hint: truncate(agent.context || '—', 40) },
      {
        value: 'communicationRules',
        label: 'Communication rules',
        hint: truncate(agent.communicationRules || '—', 40),
      },
      { value: 'workspace', label: 'Workspace override', hint: agent.workspace ?? '—' },
    ],
  });
  if (!field) return;
  const current = (agent as unknown as Record<string, string | undefined>)[field] ?? '';
  const value = await ui.dialogs.text({ title: `${agent.handle} · ${field}`, label: field, initial: current });
  if (value === undefined) return;
  const nullable = field === 'description' || field === 'workspace';
  await ui.guard(
    () => ui.core.updateAgent(agent.id, { [field]: nullable ? value.trim() || null : value }),
    'Agent updated.',
  );
}

export async function switchAgentModel(ui: Ui): Promise<void> {
  const agent = await currentAgent(ui);
  if (!agent) return;
  const model = await pickModel(ui, agent.model);
  if (!model) return;
  await ui.guard(() => ui.core.updateAgentModel(agent.id, model), `${agent.handle} now uses ${model}.`);
}

export async function changeAgentEffort(ui: Ui): Promise<void> {
  const agent = await currentAgent(ui);
  if (!agent) return;
  const effort = await pickEffort(ui, agent.effort);
  if (!effort) return;
  await ui.guard(
    () => ui.core.updateAgentEffort(agent.id, effort as Agent['effort']),
    `${agent.handle} effort: ${effort}.`,
  );
}

export async function editAgentPermissions(ui: Ui): Promise<void> {
  const agent = await currentAgent(ui);
  if (!agent) return;
  const tools = await ui.dialogs.permissions({
    title: `Capabilities · ${agent.handle}`,
    permissions: agent.tools,
    groups: ui.core.listToolGroups(),
  });
  if (!tools) return;
  await ui.guard(() => ui.core.updateAgentTools(agent.id, tools), 'Capabilities updated.');
}

export async function editAgentCommunication(ui: Ui): Promise<void> {
  const agent = await currentAgent(ui);
  if (!agent) return;
  const team = await ui.guard(() => ui.core.getTeam(agent.teamId));
  if (!team) return;
  const teammates = team.agents.filter((a) => a.id !== agent.id);
  const items: SelectItem[] = [
    { value: '*', label: 'Everyone on the team', hint: 'wildcard' },
    ...teammates.map((mate) => ({ value: mate.handle, label: mate.handle, hint: mate.role })),
  ];
  const selected = await ui.dialogs.multiselect({
    title: `${agent.handle} may message…`,
    items,
    selected: agent.canMessage,
    help: 'Selecting "Everyone" replaces the individual choices.',
  });
  if (!selected) return;
  await ui.guard(
    () => ui.core.updateAgent(agent.id, { canMessage: selected.length ? selected : [] }),
    'Routing updated.',
  );
}

export async function duplicateAgent(ui: Ui): Promise<void> {
  const agent = await currentAgent(ui);
  if (!agent) return;
  const copy = await ui.guard(() => ui.core.duplicateAgent(agent.id), 'Agent duplicated.');
  if (copy) ui.select({ agentId: copy.id });
}

export async function deleteAgent(ui: Ui): Promise<void> {
  const agent = await currentAgent(ui);
  if (!agent) return;
  const ok = await ui.dialogs.confirm({
    title: `Delete agent "${agent.handle}"?`,
    message: 'Teammates that could message it will be updated.',
    danger: true,
  });
  if (!ok) return;
  const done = await ui.guard(() => ui.core.deleteAgent(agent.id), 'Agent deleted.');
  if (done !== undefined) ui.select({ agentId: undefined });
}

export async function messageAgent(ui: Ui): Promise<void> {
  const agent = await currentAgent(ui);
  if (!agent) return;
  let run = ui.selection.runId ? await ui.core.getRun(ui.selection.runId).catch(() => undefined) : undefined;
  if (!run || run.teamId !== agent.teamId) run = await pickRun(ui, agent.teamId);
  if (!run) return;
  const target = run;
  const content = await ui.dialogs.text({
    title: `Message ${agent.handle}`,
    label: 'you',
    placeholder: 'What should this agent do next?',
  });
  if (!content?.trim()) return;
  await ui.guard(
    () =>
      ui.core.sendAgentMessage({
        runId: target.id,
        from: 'user',
        to: [agent.id],
        content,
        type: 'message',
      }),
    `Message delivered to ${agent.handle}.`,
  );
}

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

export async function startRun(ui: Ui): Promise<void> {
  const team = await currentTeam(ui);
  if (!team) return;
  // Whether a team may start a run is the runtime's rule, and so is the way it
  // is phrased: `RunManager.createRun` refuses an empty team and says why. The
  // call below goes through `guard`, which puts that message on the status
  // line — there is no second wording of the rule here.
  const objective = await ui.dialogs.text({
    title: `Start a run · ${team.name}`,
    label: 'objective',
    placeholder: 'Implement the login screen',
  });
  if (!objective?.trim()) return;
  const run = await ui.guard(
    () => ui.core.startRun({ teamId: team.id, objective }),
    'Run started.',
  );
  if (run) {
    ui.select({ runId: run.id, teamId: team.id });
    ui.setRunMode('live');
    ui.setSection('runs');
  }
}

export async function runAction(ui: Ui, action: 'pause' | 'resume' | 'cancel' | 'retry'): Promise<void> {
  const run = await currentRun(ui);
  if (!run) return;
  const allowed = availableRunActions(run.status);
  if (!allowed.includes(action)) {
    ui.notify(
      `A ${RUN_STATUS_UI[run.status].label} run cannot be ${action}ed. Available: ${allowed.join(', ') || 'nothing'}.`,
      'warning',
    );
    return;
  }
  if (action === 'cancel') {
    const ok = await ui.dialogs.confirm({
      title: 'Cancel this run?',
      message: truncate(run.objective, 70),
      danger: true,
    });
    if (!ok) return;
  }
  const next = await ui.guard(async () => {
    switch (action) {
      case 'pause':
        return ui.core.pauseRun(run.id);
      case 'resume':
        return ui.core.resumeRun(run.id);
      case 'cancel':
        return ui.core.cancelRun(run.id);
      case 'retry':
        return ui.core.retryRun(run.id);
    }
  }, `Run ${action}${action === 'retry' ? 'ing' : 'd'}.`);
  if (next) ui.select({ runId: next.id, teamId: next.teamId });
}

/**
 * Removes a run and its whole history.
 *
 * Unlike cancel, this cannot be looked at afterwards, so the prompt counts what
 * goes with it. The core refuses a run that is still executing; the message
 * here says the same thing before the round trip, because being told "cancel it
 * first" only after confirming a destructive action is poor manners.
 */
export async function deleteRun(ui: Ui): Promise<void> {
  const run = await currentRun(ui);
  if (!run) return;

  const detail = await ui.guard(() => ui.core.getRunDetail(run.id));
  if (!detail) return;
  if (detail.isActive) {
    ui.notify('This run is still executing. Cancel it (x) before deleting it.', 'warning');
    return;
  }

  const ok = await ui.dialogs.confirm({
    title: 'Delete this run?',
    message: `${truncate(run.objective, 60)} — ${detail.tasks.length} task(s), ${detail.messages.length} message(s) and ${detail.events.length} timeline entries go with it. The team is untouched.`,
    danger: true,
  });
  if (!ok) return;

  const done = await ui.guard(() => ui.core.deleteRun(run.id), 'Run deleted.');
  if (done !== undefined) ui.select({ runId: undefined });
}

/* ------------------------------------------------------------------ *
 * Questions
 * ------------------------------------------------------------------ */

/**
 * Puts the question prompt back on screen.
 *
 * The list comes from the core rather than from what this process happens to
 * have seen: a question raised before the TUI attached, or one dismissed with
 * `esc`, is still an agent waiting for an answer. `listPendingQuestions` is
 * also the only thing that knows which of them are genuinely still answerable.
 */
export async function openPendingQuestion(ui: Ui): Promise<void> {
  const pending = await ui.guard(() => ui.core.listPendingQuestions());
  if (!pending) return;
  if (pending.length === 0) {
    ui.notify('No agent is waiting on a question.', 'info');
    return;
  }
  ui.reopenQuestion(pending);
}

/* ------------------------------------------------------------------ *
 * Transcripts
 * ------------------------------------------------------------------ */

/** `14.2 KB` — only used to tell the user how much text just moved. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * The transcript of the selected run, rendered by the core.
 *
 * Both the copy and the export go through here: the document the terminal puts
 * on the clipboard and the one the browser downloads come from the same call,
 * with the same options, so they are byte-identical.
 */
async function runTranscript(ui: Ui) {
  const run = await currentRun(ui);
  if (!run) return undefined;
  const exported = await ui.guard(() =>
    ui.core.exportRun(run.id, {
      format: ui.transcript.format,
      includeDebug: ui.transcript.includeDebug,
    }),
  );
  if (!exported) return undefined;
  return { run, ...exported, bytes: Buffer.byteLength(exported.content, 'utf8') };
}

export async function copyRunTranscript(ui: Ui): Promise<void> {
  const transcript = await runTranscript(ui);
  if (!transcript) return;

  const result = await copyToClipboard(transcript.content);
  if (result.ok) {
    const caveat = result.detail ? ` — ${result.detail}` : '';
    ui.notify(
      `Copied ${formatBytes(transcript.bytes)} (${transcript.format}) to the clipboard${caveat}`,
      'success',
    );
    return;
  }
  ui.notify(
    `Could not reach the clipboard (${result.detail}). Press e to write ${transcript.fileName} to a file instead.`,
    'danger',
  );
}

export async function exportRunTranscript(ui: Ui): Promise<void> {
  const transcript = await runTranscript(ui);
  if (!transcript) return;

  const path = await ui.dialogs.text({
    title: 'Export run transcript',
    label: 'file',
    initial: resolve(process.cwd(), transcript.fileName),
    help: `${transcript.format} · ${formatBytes(transcript.bytes)} · debug events ${
      ui.transcript.includeDebug ? 'included' : 'excluded'
    }`,
  });
  if (path === undefined) return;

  const target = resolve(path.trim() || transcript.fileName);
  await ui.guard(async () => {
    await writeFile(target, transcript.content, 'utf8');
  }, `Written to ${target}`);
}

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */

export async function checkProvider(ui: Ui): Promise<void> {
  const health = await ui.guard(() => ui.core.checkProvider());
  if (!health) return;
  await ui.dialogs.info({
    title: health.ok ? 'Provider is healthy' : 'Provider problem',
    lines: [
      health.detail,
      `authenticated: ${health.authenticated ? 'yes' : 'no'}${health.authSource ? ` (${health.authSource})` : ''}`,
      health.version ? `version: ${health.version}` : '',
    ].filter(Boolean),
  });
}

/* ------------------------------------------------------------------ *
 * Command dispatch
 * ------------------------------------------------------------------ */

const NAV: Record<string, SectionId> = {
  'nav.dashboard': 'dashboard',
  'nav.teams': 'teams',
  'nav.agents': 'agents',
  'nav.runs': 'runs',
  'nav.messages': 'messages',
  'nav.activity': 'activity',
  'nav.settings': 'settings',
};

/** Runs a catalogue command by id. Every id in `COMMANDS` is handled here. */
export async function executeCommand(id: string, ui: Ui): Promise<void> {
  const section = NAV[id];
  if (section) {
    // Navigating away has to give the terminal back: the full-screen run view
    // covers every section.
    ui.setRunFullScreen(false);
    ui.setSection(section);
    return;
  }

  switch (id) {
    case 'team.create':
      return createTeam(ui);
    case 'team.fromPreset':
      return createTeamFromPreset(ui);
    case 'team.edit':
      return editTeam(ui);
    case 'team.duplicate':
      return duplicateTeam(ui);
    case 'team.export':
      return exportTeam(ui);
    case 'team.import':
      return importTeam(ui);
    case 'team.setOrchestrator':
      return setOrchestrator(ui);
    case 'team.delete':
      return deleteTeam(ui);

    case 'agent.create':
      return createAgent(ui);
    case 'agent.fromTemplate':
      return createAgentFromTemplate(ui);
    case 'agent.edit':
      return editAgent(ui);
    case 'agent.switchModel':
      return switchAgentModel(ui);
    case 'agent.changeEffort':
      return changeAgentEffort(ui);
    case 'agent.permissions':
      return editAgentPermissions(ui);
    case 'agent.communication':
      return editAgentCommunication(ui);
    case 'agent.duplicate':
      return duplicateAgent(ui);
    case 'agent.delete':
      return deleteAgent(ui);
    case 'agent.message':
      return messageAgent(ui);
    case 'agent.inspect': {
      const agent = await currentAgent(ui);
      if (!agent) return;
      ui.select({ agentId: agent.id, teamId: agent.teamId });
      ui.setSection('agents');
      ui.setFocus('detail');
      return;
    }

    case 'run.start':
      return startRun(ui);
    case 'run.pause':
      return runAction(ui, 'pause');
    case 'run.resume':
      return runAction(ui, 'resume');
    case 'run.cancel':
      return runAction(ui, 'cancel');
    case 'run.conversation': {
      // The full-screen view opens on the conversation, which is the reading
      // view a terminal has room for.
      const run = await currentRun(ui);
      if (!run) return;
      ui.select({ runId: run.id, teamId: run.teamId });
      ui.setSection('runs');
      ui.setRunFullScreen(true);
      return;
    }
    case 'run.delete':
      return deleteRun(ui);
    case 'run.retry':
      return runAction(ui, 'retry');
    case 'run.logs': {
      const run = await currentRun(ui);
      if (!run) return;
      ui.select({ runId: run.id, teamId: run.teamId });
      ui.setRunMode('live');
      ui.setSection('runs');
      ui.setRunFullScreen(false);
      ui.setFocus('detail');
      return;
    }
    case 'run.fullscreen': {
      const run = await currentRun(ui);
      if (!run) return;
      ui.select({ runId: run.id, teamId: run.teamId });
      ui.setSection('runs');
      ui.setRunFullScreen(true);
      return;
    }
    case 'run.copyTranscript':
      return copyRunTranscript(ui);
    case 'run.exportTranscript':
      return exportRunTranscript(ui);
    case 'run.replay': {
      const run = await currentRun(ui);
      if (!run) return;
      ui.select({ runId: run.id, teamId: run.teamId });
      ui.setRunMode('replay');
      ui.setSection('runs');
      ui.setRunFullScreen(false);
      ui.setFocus('detail');
      return;
    }

    case 'question.open':
      return openPendingQuestion(ui);

    case 'app.autoMode':
      ui.toggleAutoMode();
      return;
    case 'app.search':
      ui.setOverlay('search');
      return;
    case 'app.help':
      ui.setOverlay('help');
      return;
    case 'app.onboarding':
      ui.setOnboarding(true);
      return;
    case 'app.checkProvider':
      return checkProvider(ui);
    case 'app.quit':
      ui.quit();
      return;

    default:
      ui.notify(`Command "${id}" is not wired up.`, 'warning');
  }
}
