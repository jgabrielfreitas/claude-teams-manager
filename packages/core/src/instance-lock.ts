import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Single-writer guard.
 *
 * Storage is a local SQLite file (ADR-005), so exactly one process may own the
 * runtime for a given database. Without this, opening the second surface while
 * the first is mid-run is actively harmful: the newcomer's startup recovery
 * sees a `running` row, assumes the previous process died, and pauses a run
 * that is very much alive.
 *
 * The lock is advisory and crash-safe: it records a pid and a heartbeat, and a
 * stale lock (dead pid, or no heartbeat for `STALE_AFTER_MS`) is taken over
 * rather than blocking the user forever.
 */

const LOCK_FILE = 'instance.lock';
const HEARTBEAT_MS = 10_000;
const STALE_AFTER_MS = 45_000;

/** Lock paths already owned by a core inside this process, and since when. */
const heldInThisProcess = new Map<string, Date>();

export interface InstanceInfo {
  /** True when this process owns the runtime for its database. */
  isPrimary: boolean;
  /** Pid of the process that already holds it, when we are secondary. */
  heldByPid?: number;
  /** Since when that process has held it. */
  heldSince?: Date;
  /** Absolute path of the lock file, or undefined when locking is not used. */
  path?: string;
}

interface LockRecord {
  pid: number;
  startedAt: number;
  heartbeatAt: number;
}

export interface InstanceLock extends InstanceInfo {
  release(): void;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(path: string): LockRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as LockRecord;
    if (typeof raw?.pid !== 'number') return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/**
 * Attempts to become the primary instance for the database at `databasePath`.
 * In-memory databases are never locked — every test gets its own runtime.
 */
export function acquireInstanceLock(databasePath: string): InstanceLock {
  if (!databasePath || databasePath === ':memory:') {
    return { isPrimary: true, release: () => {} };
  }

  const dir = dirname(databasePath);
  const path = join(dir, LOCK_FILE);

  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // If we cannot even create the directory, storage will fail loudly later.
    return { isPrimary: true, release: () => {} };
  }

  // A second core constructed inside this same process is just as much a
  // second owner as one in another process — and the pid check below cannot
  // see it, so track ownership here too.
  const heldHere = heldInThisProcess.get(path);
  if (heldHere) {
    return {
      isPrimary: false,
      heldByPid: process.pid,
      heldSince: heldHere,
      path,
      release: () => {},
    };
  }

  const existing = readLock(path);
  if (existing && existing.pid !== process.pid) {
    const fresh = Date.now() - existing.heartbeatAt < STALE_AFTER_MS;
    if (fresh && isAlive(existing.pid)) {
      return {
        isPrimary: false,
        heldByPid: existing.pid,
        heldSince: new Date(existing.startedAt),
        path,
        release: () => {},
      };
    }
  }

  const record: LockRecord = {
    pid: process.pid,
    startedAt: existing?.pid === process.pid ? existing.startedAt : Date.now(),
    heartbeatAt: Date.now(),
  };

  try {
    writeFileSync(path, JSON.stringify(record), 'utf8');
  } catch {
    // A read-only home directory is not a reason to refuse to run.
    return { isPrimary: true, path, release: () => {} };
  }

  heldInThisProcess.set(path, new Date(record.startedAt));

  const timer = setInterval(() => {
    try {
      const current = readLock(path);
      // Only refresh a lock we still own; never steal one back.
      if (current && current.pid !== process.pid) return;
      writeFileSync(path, JSON.stringify({ ...record, heartbeatAt: Date.now() }), 'utf8');
    } catch {
      /* transient filesystem trouble must not crash the app */
    }
  }, HEARTBEAT_MS);
  timer.unref?.();

  return {
    isPrimary: true,
    heldByPid: process.pid,
    heldSince: new Date(record.startedAt),
    path,
    release: () => {
      clearInterval(timer);
      heldInThisProcess.delete(path);
      try {
        const current = readLock(path);
        if (!current || current.pid === process.pid) rmSync(path, { force: true });
      } catch {
        /* nothing useful to do while shutting down */
      }
    },
  };
}
