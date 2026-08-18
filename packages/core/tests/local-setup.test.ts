import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '@claude-team/persistence';
import { FakeAgentProvider, type FakeStep } from '@claude-team/provider';
import { AppCore } from '../src/app-core.js';

/**
 * Reusing the machine's own Claude Code installation.
 *
 * The value of this setting is entirely in whether it reaches the subprocess:
 * a stored preference that never becomes a provider argument looks identical
 * in the UI and does nothing at all. So the assertion is on what the provider
 * was actually handed, for every activation of the run.
 */

const DONE: FakeStep[] = [{ kind: 'tool', tool: 'finish', args: { summary: 'done' } }];

async function coreWithSetup(localSetup?: Record<string, unknown>) {
  const provider = new FakeAgentProvider({ behaviors: { assistant: DONE } as never });
  const app = new AppCore({ storage: new InMemoryStorage(), provider });
  await app.init();
  if (localSetup) await app.updateSettings({ localSetup });
  const team = await app.createTeamFromPreset({ presetId: 'solo' });
  const run = await app.startRun({ teamId: team.id, objective: 'Do the thing' });
  await app.waitForRun(run.id);
  return { app, provider };
}

describe('local Claude Code setup', () => {
  it('runs isolated by default', async () => {
    const { app, provider } = await coreWithSetup();

    expect(provider.activations.length).toBeGreaterThan(0);
    for (const activation of provider.activations) {
      expect(activation.localSetup).toEqual({
        settingSources: [],
        skills: 'none',
        mcpServers: false,
      });
    }

    await app.shutdown();
  }, 30_000);

  it('hands what you configured to every activation', async () => {
    const { app, provider } = await coreWithSetup({
      settingSources: ['user', 'project'],
      skills: 'all',
      mcpServers: true,
    });

    for (const activation of provider.activations) {
      expect(activation.localSetup).toEqual({
        settingSources: ['user', 'project'],
        skills: 'all',
        mcpServers: true,
      });
    }

    await app.shutdown();
  }, 30_000);

  it('takes effect on the next run, without restarting the process', async () => {
    const provider = new FakeAgentProvider({ behaviors: { assistant: DONE } as never });
    const app = new AppCore({ storage: new InMemoryStorage(), provider });
    await app.init();
    const team = await app.createTeamFromPreset({ presetId: 'solo' });

    const first = await app.startRun({ teamId: team.id, objective: 'Before' });
    await app.waitForRun(first.id);
    const before = provider.activations.length;

    await app.updateSettings({
      localSetup: { settingSources: ['project'], skills: ['pdf'], mcpServers: false },
    });

    const second = await app.startRun({ teamId: team.id, objective: 'After' });
    await app.waitForRun(second.id);

    expect(provider.activations[0]!.localSetup?.settingSources).toEqual([]);
    expect(provider.activations[before]!.localSetup).toEqual({
      settingSources: ['project'],
      skills: ['pdf'],
      mcpServers: false,
    });

    await app.shutdown();
  }, 30_000);

  it('refuses a setting source that is not one Claude Code understands', async () => {
    const app = new AppCore({
      storage: new InMemoryStorage(),
      provider: new FakeAgentProvider({ behaviors: { assistant: DONE } as never }),
    });
    await app.init();

    await expect(
      app.updateSettings({
        localSetup: { settingSources: ['everything'], skills: 'all', mcpServers: false },
      }),
    ).rejects.toThrow();

    await app.shutdown();
  }, 30_000);
});
