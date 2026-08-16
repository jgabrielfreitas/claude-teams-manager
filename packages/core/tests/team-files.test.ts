import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStorage } from '@claude-team/persistence';
import { FakeAgentProvider } from '@claude-team/provider';
import { AppCore } from '../src/app-core.js';

/**
 * The teams folder is a mirror of the database, kept accurate so that the YAML
 * a user finds there can always be imported as-is.
 */

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-teamfiles-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function open(home: string): Promise<AppCore> {
  const app = new AppCore({
    storage: new SqliteStorage({ location: join(home, 'claude-team.db') }),
    provider: new FakeAgentProvider(),
  });
  await app.init();
  return app;
}

function filesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe('team files', () => {
  it('writes a YAML file next to the database whenever a team is created', async () => {
    const home = tempHome();
    const app = await open(home);
    const teamsDir = join(home, 'teams');

    expect(app.teamsDirectory()).toBe(teamsDir);

    const team = await app.createTeamFromPreset({ presetId: 'software-engineering', name: 'Growth' });
    const files = filesIn(teamsDir);

    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`growth.${team.id}.yaml`);
    expect(await app.teamFilePath(team.id)).toBe(join(teamsDir, files[0]));

    const yaml = readFileSync(join(teamsDir, files[0]), 'utf8');
    expect(yaml).toContain('# Growth');
    expect(yaml).toContain('claude-team team import');
    expect(yaml).toContain('orchestrator: architect');
    expect(yaml).toContain('effort: high');

    await app.shutdown();
  }, 30_000);

  it('rewrites the file when an agent’s model or effort changes', async () => {
    const home = tempHome();
    const app = await open(home);
    const team = await app.createTeamFromPreset({ presetId: 'software-engineering' });
    const path = (await app.teamFilePath(team.id))!;

    expect(readFileSync(path, 'utf8')).not.toContain('claude-opus-4-8');

    const backend = team.agents.find((a) => a.handle === 'backend')!;
    await app.updateAgentModel(backend.id, 'claude-opus-4-8');
    await app.updateAgentEffort(backend.id, 'max');

    const yaml = readFileSync(path, 'utf8');
    expect(yaml).toContain('claude-opus-4-8');
    expect(yaml).toContain('effort: max');

    await app.shutdown();
  }, 30_000);

  it('tracks adding, renaming and deleting', async () => {
    const home = tempHome();
    const app = await open(home);
    const teamsDir = join(home, 'teams');

    const team = await app.createTeam({ name: 'Content' });
    await app.createAgent({ teamId: team.id, name: 'Writer', role: 'Copywriter' });
    expect(readFileSync(join(teamsDir, `content.${team.id}.yaml`), 'utf8')).toContain('Copywriter');

    // A rename replaces the file rather than leaving both behind.
    await app.updateTeam(team.id, { name: 'Content Machine' });
    expect(filesIn(teamsDir)).toEqual([`content-machine.${team.id}.yaml`]);

    await app.deleteTeam(team.id);
    expect(filesIn(teamsDir)).toEqual([]);

    await app.shutdown();
  }, 30_000);

  it('produces a file that imports back into an identical team', async () => {
    const home = tempHome();
    const app = await open(home);
    const original = await app.createTeamFromPreset({ presetId: 'research', name: 'Insights' });
    await app.updateAgentEffort(original.agents[2].id, 'max');

    const yaml = readFileSync((await app.teamFilePath(original.id))!, 'utf8');
    const { team: imported, warnings } = await app.importTeam(yaml, { name: 'Insights Copy' });

    expect(warnings).toEqual([]);
    const current = await app.getTeam(original.id);
    expect(imported.agents.map((a) => `${a.handle}/${a.model}/${a.effort}`)).toEqual(
      current.agents.map((a) => `${a.handle}/${a.model}/${a.effort}`),
    );
    // ...and the import itself produced its own file.
    expect(filesIn(join(home, 'teams'))).toHaveLength(2);

    await app.shutdown();
  }, 30_000);

  it('populates the folder for a database that predates it, and follows a move', async () => {
    const home = tempHome();
    const first = await open(home);
    const team = await first.createTeamFromPreset({ presetId: 'solo', name: 'Alone' });
    await first.shutdown();

    // Someone deletes the folder while the app is closed.
    rmSync(join(home, 'teams'), { recursive: true, force: true });
    expect(filesIn(join(home, 'teams'))).toEqual([]);

    const second = await open(home);
    expect(filesIn(join(home, 'teams'))).toEqual([`alone.${team.id}.yaml`]);

    // Pointing it at a new directory populates that one immediately.
    const elsewhere = join(home, 'my-repo', 'teams');
    await second.updateSettings({ teamsDir: elsewhere });
    expect(second.teamsDirectory()).toBe(elsewhere);
    expect(filesIn(elsewhere)).toEqual([`alone.${team.id}.yaml`]);

    await second.shutdown();
  }, 30_000);

  it('never writes files for an in-memory store', async () => {
    const { InMemoryStorage } = await import('@claude-team/persistence');
    const app = new AppCore({ storage: new InMemoryStorage(), provider: new FakeAgentProvider() });
    await app.init();

    expect(app.teamsDirectory()).toBeUndefined();
    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    expect(await app.teamFilePath(team.id)).toBeUndefined();

    await app.shutdown();
  });
});
