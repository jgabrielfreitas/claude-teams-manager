import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryStorage, SqliteStorage } from '@claude-team/persistence';
import { FakeAgentProvider } from '@claude-team/provider';
import { AppCore } from '../src/app-core.js';

/**
 * Use-case level tests. These call exactly the methods both UIs call, so a
 * regression here is a regression in the TUI and the Web at the same time.
 */

async function core(): Promise<AppCore> {
  const app = new AppCore({ storage: new InMemoryStorage(), provider: new FakeAgentProvider() });
  await app.init();
  return app;
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('team use cases', () => {
  it('creates, updates, duplicates and deletes a team', async () => {
    const app = await core();

    const created = await app.createTeam({ name: 'Engineering', description: 'Ships things' });
    expect(created.agents).toEqual([]);

    const updated = await app.updateTeam(created.id, { description: 'Ships good things' });
    expect(updated.description).toBe('Ships good things');

    await app.createAgent({ teamId: created.id, name: 'Architect', role: 'Architect' });
    const copy = await app.duplicateTeam(created.id);
    expect(copy.id).not.toBe(created.id);
    expect(copy.name).toBe('Engineering (copy)');
    expect(copy.agents).toHaveLength(1);
    expect(copy.agents[0].id).not.toBe((await app.getTeam(created.id)).agents[0].id);
    // The orchestrator reference was remapped to the copy's own agent.
    expect(copy.orchestratorId).toBe(copy.agents[0].id);

    await app.deleteTeam(created.id);
    await expect(app.getTeam(created.id)).rejects.toThrow(/not found/i);
    await app.shutdown();
  });

  it('expands a preset into fully configured agents', async () => {
    const app = await core();
    const team = await app.createTeamFromPreset({ presetId: 'software-engineering' });

    expect(team.agents).toHaveLength(5);
    const architect = team.agents.find((a) => a.handle === 'architect')!;
    const frontend = team.agents.find((a) => a.handle === 'frontend')!;

    expect(team.orchestratorId).toBe(architect.id);
    expect(architect.effort).toBe('high');
    expect(frontend.effort).toBe('medium');
    expect(architect.model).not.toBe(frontend.model);
    expect(architect.systemPrompt.length).toBeGreaterThan(50);
    expect(frontend.canMessage).toContain('architect');
    await app.shutdown();
  });

  it('advertises presets already resolved to what creation will produce', async () => {
    const app = await core();
    const preset = app.listPresets().find((p) => p.id === 'software-engineering')!;

    // Every member is concrete: a UI previewing this cannot promise a model or
    // effort that `createTeamFromPreset` would not actually use.
    for (const member of preset.members) {
      expect(member.handle).toBeTruthy();
      expect(member.model).toBeTruthy();
      expect(member.effort).toBeTruthy();
    }

    const team = await app.createTeamFromPreset({ presetId: preset.id });
    expect(team.agents.map((a) => `${a.handle}:${a.model}:${a.effort}`)).toEqual(
      preset.members.map((m) => `${m.handle}:${m.model}:${m.effort}`),
    );
    expect(preset.members.find((m) => m.orchestrator)?.handle).toBe(
      team.agents.find((a) => a.id === team.orchestratorId)?.handle,
    );
    await app.shutdown();
  });

  it('applies per-agent model and effort overrides from the wizard', async () => {
    const app = await core();
    const team = await app.createTeamFromPreset({
      presetId: 'software-engineering',
      overrides: { backend: { model: 'haiku', effort: 'low' } },
    });

    const backend = team.agents.find((a) => a.handle === 'backend')!;
    const qa = team.agents.find((a) => a.handle === 'qa')!;
    expect(backend.model).toBe('haiku');
    expect(backend.effort).toBe('low');
    // Nobody else moved.
    expect(qa.effort).toBe('high');
    await app.shutdown();
  });
});

describe('agent use cases', () => {
  it('changes one agent’s model and effort without touching the rest of the team', async () => {
    const app = await core();
    const team = await app.createTeamFromPreset({ presetId: 'software-engineering' });
    const before = team.agents.map((a) => `${a.handle}:${a.model}:${a.effort}`);

    const backend = team.agents.find((a) => a.handle === 'backend')!;
    await app.updateAgentModel(backend.id, 'claude-opus-4-8');
    const changed = await app.updateAgentEffort(backend.id, 'max');

    expect(changed.model).toBe('claude-opus-4-8');
    expect(changed.effort).toBe('max');

    const after = (await app.getTeam(team.id)).agents.map((a) => `${a.handle}:${a.model}:${a.effort}`);
    const differences = after.filter((row, i) => row !== before[i]);
    expect(differences).toEqual(['backend:claude-opus-4-8:max']);
    await app.shutdown();
  });

  it('accepts a model id the catalogue has never heard of', async () => {
    const app = await core();
    const team = await app.createTeam({ name: 'T' });
    const agent = await app.createAgent({ teamId: team.id, name: 'A', role: 'R' });

    const updated = await app.updateAgentModel(agent.id, 'claude-model-from-the-future');
    expect(updated.model).toBe('claude-model-from-the-future');
    // ...and a picker still offers it, because it is in use.
    expect((await app.listModelsInUse()).map((m) => m.id)).toContain('claude-model-from-the-future');
    await app.shutdown();
  });

  it('creates an agent from a template and duplicates it', async () => {
    const app = await core();
    const team = await app.createTeam({ name: 'T' });

    const agent = await app.createAgentFromTemplate({
      teamId: team.id,
      templateId: 'backend-engineer',
    });
    expect(agent.role).toBe('Backend Engineer');
    expect(agent.templateId).toBe('backend-engineer');

    const auth = await app.duplicateAgent(agent.id, { name: 'Backend Auth', handle: 'backend-auth' });
    const payments = await app.duplicateAgent(agent.id, {
      name: 'Backend Payments',
      handle: 'backend-payments',
    });

    expect([auth.handle, payments.handle]).toEqual(['backend-auth', 'backend-payments']);
    expect(auth.systemPrompt).toBe(agent.systemPrompt);
    expect(auth.model).toBe(agent.model);
    await app.shutdown();
  });

  it('validates communication targets and repairs them on rename and delete', async () => {
    const app = await core();
    const team = await app.createTeamFromPreset({ presetId: 'software-engineering' });
    const backend = team.agents.find((a) => a.handle === 'backend')!;
    const frontend = team.agents.find((a) => a.handle === 'frontend')!;

    await expect(app.updateAgent(backend.id, { canMessage: ['nobody'] })).rejects.toThrow(
      /not a teammate/i,
    );

    // Renaming an agent rewrites the handle everywhere it is referenced.
    await app.updateAgent(frontend.id, { handle: 'web' });
    const afterRename = await app.getAgent(backend.id);
    expect(afterRename.canMessage).toContain('web');
    expect(afterRename.canMessage).not.toContain('frontend');

    // Deleting an agent removes it from everyone's routing list.
    await app.deleteAgent(frontend.id);
    const afterDelete = await app.getAgent(backend.id);
    expect(afterDelete.canMessage).not.toContain('web');
    await app.shutdown();
  });

  it('promotes a replacement orchestrator when the current one is deleted', async () => {
    const app = await core();
    const team = await app.createTeamFromPreset({ presetId: 'software-engineering' });
    const architect = team.agents.find((a) => a.handle === 'architect')!;

    await app.deleteAgent(architect.id);
    const after = await app.getTeam(team.id);
    expect(after.orchestratorId).toBeDefined();
    expect(after.orchestratorId).not.toBe(architect.id);
    expect(after.agents.some((a) => a.id === after.orchestratorId)).toBe(true);
    await app.shutdown();
  });

  it('refuses an orchestrator that is not on the team', async () => {
    const app = await core();
    const a = await app.createTeamFromPreset({ presetId: 'solo' });
    const b = await app.createTeamFromPreset({ presetId: 'solo' });

    await expect(app.updateTeam(a.id, { orchestratorId: b.agents[0].id })).rejects.toThrow(
      /not a member/i,
    );
    await app.shutdown();
  });
});

describe('workspace checks before a run', () => {
  it('refuses a run whose workspace does not exist, naming the path and the owner', async () => {
    const app = await core();
    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    await app.updateTeam(team.id, { workspace: '/definitely/not/a/real/directory' });

    // Without this check the failure surfaces from deep inside the provider as
    // a native-binary/libc error, which sends people looking in the wrong place.
    await expect(
      app.startRun({ teamId: team.id, objective: 'anything' }),
    ).rejects.toThrow(/workspace for team .* does not exist: \/definitely\/not\/a\/real\/directory/i);

    // Nothing was created for a run that could never have started.
    expect(await app.listRuns()).toEqual([]);
    await app.shutdown();
  });

  it('checks a per-agent workspace override too', async () => {
    const app = await core();
    const team = await app.createTeamFromPreset({ presetId: 'software-engineering' });
    await app.updateTeam(team.id, { workspace: process.cwd() });
    const backend = team.agents.find((a) => a.handle === 'backend')!;
    await app.updateAgent(backend.id, { workspace: '/nope/not/here' });

    await expect(app.startRun({ teamId: team.id, objective: 'anything' })).rejects.toThrow(
      /agent "backend"/i,
    );
    await app.shutdown();
  });

  it('starts happily when the workspace is a real directory', async () => {
    const app = await core();
    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    await app.updateTeam(team.id, { workspace: process.cwd() });

    const run = await app.startRun({ teamId: team.id, objective: 'anything' });
    await app.waitForRun(run.id);
    expect((await app.getRun(run.id)).status).toBe('completed');
    await app.shutdown();
  }, 30_000);
});

describe('import and export', () => {
  it('round-trips a team through YAML', async () => {
    const app = await core();
    const original = await app.createTeamFromPreset({ presetId: 'software-engineering' });
    await app.updateAgentEffort(original.agents[1].id, 'max');

    const yaml = await app.exportTeam(original.id);
    expect(yaml).toContain('orchestrator: architect');
    expect(yaml).toContain('effort: max');

    const { team: imported, warnings } = await app.importTeam(yaml, { name: 'Imported' });
    // Compare against the stored team, not the snapshot taken before the edit.
    const current = await app.getTeam(original.id);

    expect(warnings).toEqual([]);
    expect(imported.name).toBe('Imported');
    expect(imported.agents.map((a) => a.handle)).toEqual(current.agents.map((a) => a.handle));
    expect(imported.agents.map((a) => `${a.model}/${a.effort}`)).toEqual(
      current.agents.map((a) => `${a.model}/${a.effort}`),
    );
    expect(imported.orchestratorId).toBe(
      imported.agents.find((a) => a.handle === 'architect')!.id,
    );
    await app.shutdown();
  });

  it('rejects YAML that is not a team file', async () => {
    const app = await core();
    await expect(app.importTeam('name: [unclosed')).rejects.toThrow(/valid yaml/i);
    await expect(app.importTeam('just: a map\n')).rejects.toThrow(/invalid team file/i);
    await app.shutdown();
  });
});

describe('settings and search', () => {
  it('persists settings and pushes them into the engine', async () => {
    const app = await core();
    const updated = await app.updateSettings({ autoApproveAll: true, maxHops: 3, defaultEffort: 'high' });

    expect(updated.autoApproveAll).toBe(true);
    expect(app.runs.getOptions().autoApproveAll).toBe(true);
    expect(app.runs.getOptions().maxHops).toBe(3);

    const reread = await app.getSettings();
    expect(reread.defaultEffort).toBe('high');
    await app.shutdown();
  });

  it('finds teams, agents and runs', async () => {
    const app = await core();
    const team = await app.createTeamFromPreset({ presetId: 'software-engineering', name: 'Payments' });
    await app.startRun({
      teamId: team.id,
      objective: 'Implement refund flow',
      autoStart: false,
    });

    const teamHits = await app.search('Payments');
    expect(teamHits[0].kind).toBe('team');

    const agentHits = await app.search('reviewer');
    expect(agentHits.some((h) => h.kind === 'agent')).toBe(true);

    const runHits = await app.search('refund');
    expect(runHits.some((h) => h.kind === 'run')).toBe(true);
    await app.shutdown();
  });
});

describe('persistence across restarts', () => {
  it('recovers teams, agents and run history from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-team-test-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'claude-team.db');

    const first = new AppCore({
      storage: new SqliteStorage({ location: dbPath }),
      provider: new FakeAgentProvider(),
    });
    await first.init();

    const team = await first.createTeamFromPreset({ presetId: 'software-engineering', name: 'Persisted' });
    const backend = team.agents.find((a) => a.handle === 'backend')!;
    await first.updateAgentModel(backend.id, 'opus');
    await first.updateAgentEffort(backend.id, 'max');
    const run = await first.startRun({ teamId: team.id, objective: 'Remembered objective' });
    await first.waitForRun(run.id);
    await first.updateSettings({ webPort: 4444 });
    await first.shutdown();

    // A brand new process, same database.
    const second = new AppCore({
      storage: new SqliteStorage({ location: dbPath }),
      provider: new FakeAgentProvider(),
    });
    await second.init();

    const teams = await second.listTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0].name).toBe('Persisted');

    const restored = teams[0].agents.find((a) => a.handle === 'backend')!;
    expect(restored.model).toBe('opus');
    expect(restored.effort).toBe('max');
    expect(restored.status).toBe('idle');

    const runs = await second.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].objective).toBe('Remembered objective');

    const detail = await second.getRunDetail(runs[0].id);
    expect(detail.events.length).toBeGreaterThan(0);
    expect(detail.run.agentConfigSnapshot.find((s) => s.handle === 'backend')).toMatchObject({
      model: 'opus',
      effort: 'max',
    });

    expect((await second.getSettings()).webPort).toBe(4444);
    await second.shutdown();
  }, 30_000);

  it('pauses runs that a previous process left mid-flight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-team-test-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'claude-team.db');

    const first = new AppCore({
      storage: new SqliteStorage({ location: dbPath }),
      provider: new FakeAgentProvider(),
    });
    await first.init();
    const team = await first.createTeamFromPreset({ presetId: 'solo' });
    const run = await first.startRun({ teamId: team.id, objective: 'Never finished', autoStart: false });
    await first.shutdown();

    // Simulate a process that died mid-run: a `running` row left behind with
    // nobody executing it. (Written outside a core, because a core that shuts
    // down cleanly would never leave one.)
    const raw = new SqliteStorage({ location: dbPath });
    await raw.init();
    const stranded = await raw.runs.get(run.id);
    await raw.runs.update({ ...stranded!, status: 'running' });
    await raw.close();

    const second = new AppCore({
      storage: new SqliteStorage({ location: dbPath }),
      provider: new FakeAgentProvider(),
    });
    await second.init();

    const recovered = await second.getRun(run.id);
    expect(recovered.status).toBe('paused');
    expect(recovered.error).toMatch(/restart/i);
    await second.shutdown();
  }, 30_000);
});
