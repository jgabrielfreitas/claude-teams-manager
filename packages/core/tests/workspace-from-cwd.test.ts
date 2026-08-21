import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '@claude-team/persistence';
import { FakeAgentProvider, type FakeStep } from '@claude-team/provider';
import { AppCore } from '../src/app-core.js';

/**
 * Where a run works.
 *
 * `claude-team` is a command-line tool, so standing in a project and asking for
 * work means work on that project. The directory the command was called from is
 * therefore the default, ahead of whatever a team happens to have stored — a
 * team pinned to a folder from months ago should not silently win.
 */

const FINISH: FakeStep[] = [{ kind: 'tool', tool: 'finish', args: { summary: 'done' } }];

function coreIn(workspace?: string) {
  const provider = new FakeAgentProvider({ behaviors: { assistant: FINISH } as never });
  const app = new AppCore({
    storage: new InMemoryStorage(),
    provider,
    ...(workspace ? { workspace } : {}),
  });
  return { app, provider };
}

describe('the directory a run works in', () => {
  it('is where the command was called', async () => {
    const called = mkdtempSync(join(tmpdir(), 'ct-called-'));
    const { app, provider } = coreIn(called);
    await app.init();

    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const run = await app.startRun({ teamId: team.id, objective: 'Work here' });
    await app.waitForRun(run.id);

    expect((await app.getRun(run.id)).workspace).toBe(called);
    // And it is what the agent is actually spawned with, not just a stored field.
    expect(provider.activations[0]!.cwd).toBe(called);

    await app.shutdown();
  }, 30_000);

  it('beats a directory the team was pinned to', async () => {
    const called = mkdtempSync(join(tmpdir(), 'ct-called-'));
    const pinned = mkdtempSync(join(tmpdir(), 'ct-pinned-'));
    const { app } = coreIn(called);
    await app.init();

    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    await app.updateTeam(team.id, { workspace: pinned });
    expect((await app.getTeam(team.id)).workspace).toBe(pinned);

    const run = await app.startRun({ teamId: team.id, objective: 'Work here' });
    expect((await app.getRun(run.id)).workspace).toBe(called);

    await app.waitForRun(run.id);
    await app.shutdown();
  }, 30_000);

  it('yields to a directory asked for explicitly, per run', async () => {
    const called = mkdtempSync(join(tmpdir(), 'ct-called-'));
    const asked = mkdtempSync(join(tmpdir(), 'ct-asked-'));
    const { app } = coreIn(called);
    await app.init();

    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    const run = await app.startRun({
      teamId: team.id,
      objective: 'Work over there',
      workspace: asked,
    });

    expect((await app.getRun(run.id)).workspace).toBe(asked);

    await app.waitForRun(run.id);
    await app.shutdown();
  }, 30_000);

  it('falls back to the team when there is no terminal behind the process', async () => {
    const pinned = mkdtempSync(join(tmpdir(), 'ct-pinned-'));
    const { app } = coreIn(undefined);
    await app.init();

    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    await app.updateTeam(team.id, { workspace: pinned });

    const run = await app.startRun({ teamId: team.id, objective: 'Scheduled work' });
    expect((await app.getRun(run.id)).workspace).toBe(pinned);

    await app.waitForRun(run.id);
    await app.shutdown();
  }, 30_000);

  it('gives a new team the directory it was created from', async () => {
    const called = mkdtempSync(join(tmpdir(), 'ct-called-'));
    const { app } = coreIn(called);
    await app.init();

    const fromPreset = await app.createTeamFromPreset({ presetId: 'solo' });
    expect(fromPreset.workspace).toBe(called);

    const blank = await app.createTeam({ name: 'Blank', workspace: undefined });
    expect(blank.workspace).toBe(called);

    await app.shutdown();
  }, 30_000);

  it('explains where a run would go, and why', async () => {
    const called = mkdtempSync(join(tmpdir(), 'ct-called-'));
    const pinned = mkdtempSync(join(tmpdir(), 'ct-pinned-'));
    const { app } = coreIn(called);
    await app.init();
    const team = await app.createTeamFromPreset({ presetId: 'solo' });
    await app.updateTeam(team.id, { workspace: pinned });

    expect(await app.resolveWorkspace({ teamId: team.id })).toEqual({
      path: called,
      source: 'invocation',
    });
    expect(await app.resolveWorkspace({ teamId: team.id, requested: pinned })).toEqual({
      path: pinned,
      source: 'requested',
    });

    await app.shutdown();
  }, 30_000);
});
