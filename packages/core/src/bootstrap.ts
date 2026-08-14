import { homedir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage, InMemoryStorage, type Storage } from '@claude-team/persistence';
import { createProvider, type AgentProvider } from '@claude-team/provider';
import { AppCore } from './app-core.js';

/**
 * One-call construction of a ready-to-use core.
 *
 * Both entry points (the TUI binary and the web server) call this, so the wiring
 * of storage → provider → runtime → core exists in exactly one place.
 */

export interface BootstrapOptions {
  /** Path to the SQLite file, `:memory:`, or omitted for the default location. */
  dbPath?: string;
  /** Provider id; defaults to the value stored in settings. */
  provider?: string;
  providerOptions?: Record<string, unknown>;
  /** Inject a storage/provider directly — used by tests. */
  storage?: Storage;
  providerInstance?: AgentProvider;
}

export function claudeTeamHome(): string {
  return process.env.CLAUDE_TEAM_HOME?.trim() || join(homedir(), '.claude-team');
}

export async function createAppCore(options: BootstrapOptions = {}): Promise<AppCore> {
  const storage =
    options.storage ??
    (options.dbPath === ':memory:'
      ? new InMemoryStorage()
      : new SqliteStorage({ location: options.dbPath }));

  await storage.init();

  // Settings decide the provider unless the caller forced one.
  const settings = await storage.settings.get();
  const providerId = options.provider ?? settings.provider ?? 'claude';
  const provider = options.providerInstance ?? createProvider(providerId, options.providerOptions);

  const core = new AppCore({ storage, provider });
  await core.init();
  return core;
}

/** Convenience for tests: an entirely in-memory core with a fake provider. */
export async function createTestCore(providerOptions?: Record<string, unknown>): Promise<AppCore> {
  return createAppCore({
    storage: new InMemoryStorage(),
    providerInstance: createProvider('fake', providerOptions),
  });
}
