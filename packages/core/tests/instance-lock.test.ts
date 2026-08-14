import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStorage } from '@claude-team/persistence';
import { FakeAgentProvider } from '@claude-team/provider';
import { AppCore } from '../src/app-core.js';
import { acquireInstanceLock } from '../src/instance-lock.js';

/**
 * Storage is a local SQLite file, so exactly one process may own the runtime.
 * Without the lock, opening the second surface mid-run would make its startup
 * recovery pause a run that is still executing in the first.
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-lock-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('instance lock', () => {
  it('never locks an in-memory database', () => {
    const lock = acquireInstanceLock(':memory:');
    expect(lock.isPrimary).toBe(true);
    expect(lock.path).toBeUndefined();
    lock.release();
  });

  it('grants the lock to the first process and denies a live second one', () => {
    const dir = tempDir();
    const db = join(dir, 'claude-team.db');

    const first = acquireInstanceLock(db);
    expect(first.isPrimary).toBe(true);
    expect(existsSync(join(dir, 'instance.lock'))).toBe(true);

    // A second acquisition inside this process is refused too.
    const sameProcess = acquireInstanceLock(db);
    expect(sameProcess.isPrimary).toBe(false);
    expect(sameProcess.heldByPid).toBe(process.pid);
    first.release();

    // And so is one where the file names another living process (pid 1 always
    // exists on POSIX).
    writeFileSync(
      join(dir, 'instance.lock'),
      JSON.stringify({ pid: 1, startedAt: Date.now(), heartbeatAt: Date.now() }),
    );
    const otherProcess = acquireInstanceLock(db);
    expect(otherProcess.isPrimary).toBe(false);
    expect(otherProcess.heldByPid).toBe(1);
  });

  it('takes over a lock left by a dead process', () => {
    const dir = tempDir();
    const db = join(dir, 'claude-team.db');
    // A pid that cannot be running.
    writeFileSync(
      join(dir, 'instance.lock'),
      JSON.stringify({ pid: 2 ** 30, startedAt: Date.now(), heartbeatAt: Date.now() }),
    );

    const lock = acquireInstanceLock(db);
    expect(lock.isPrimary).toBe(true);
    lock.release();
  });

  it('takes over a lock whose heartbeat went stale', () => {
    const dir = tempDir();
    const db = join(dir, 'claude-team.db');
    writeFileSync(
      join(dir, 'instance.lock'),
      JSON.stringify({ pid: 1, startedAt: Date.now() - 600_000, heartbeatAt: Date.now() - 600_000 }),
    );

    const lock = acquireInstanceLock(db);
    expect(lock.isPrimary).toBe(true);
    lock.release();
  });

  it('releases the lock so the next process can take it', () => {
    const dir = tempDir();
    const db = join(dir, 'claude-team.db');

    const first = acquireInstanceLock(db);
    first.release();
    expect(existsSync(join(dir, 'instance.lock'))).toBe(false);

    const second = acquireInstanceLock(db);
    expect(second.isPrimary).toBe(true);
    second.release();
  });
});

describe('a secondary instance leaves the primary’s runs alone', () => {
  it('does not pause a run that another process is executing', async () => {
    const dir = tempDir();
    const db = join(dir, 'claude-team.db');

    const primary = new AppCore({
      storage: new SqliteStorage({ location: db }),
      provider: new FakeAgentProvider(),
    });
    await primary.init();
    expect(primary.instanceInfo().isPrimary).toBe(true);

    const team = await primary.createTeamFromPreset({ presetId: 'solo' });
    const run = await primary.startRun({
      teamId: team.id,
      objective: 'Long-lived work',
      autoStart: false,
    });
    // Put the run into the state a live run would be in.
    await primary.storage.runs.update({ ...(await primary.getRun(run.id)), status: 'running' });

    // A second surface opens against the same database while the first is live.
    const secondary = new AppCore({
      storage: new SqliteStorage({ location: db }),
      provider: new FakeAgentProvider(),
    });
    await secondary.init();

    expect(secondary.instanceInfo().isPrimary).toBe(false);
    expect(secondary.instanceInfo().heldByPid).toBe(process.pid);

    // The crucial assertion: the running run was NOT paused out from under the
    // process that owns it.
    expect((await secondary.getRun(run.id)).status).toBe('running');
    expect((await primary.getRun(run.id)).status).toBe('running');

    // It can still read everything — both surfaces show the same data.
    expect((await secondary.listTeams())[0].name).toBe(team.name);

    await secondary.shutdown();
    await primary.shutdown();
  }, 30_000);
});
