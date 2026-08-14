/**
 * Smoke test against the REAL Claude provider.
 * Cheap on purpose: one agent, haiku, low effort, read-only, tiny objective.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@claude-team/persistence';
import { ClaudeProvider } from '@claude-team/provider';
import { AppCore } from '@claude-team/core';

const workspace = mkdtempSync(join(tmpdir(), 'ct-smoke-'));
writeFileSync(join(workspace, 'VERSION.txt'), 'the version is 7.3.1\n');

const provider = new ClaudeProvider();

console.log('--- health check ---');
const health = await provider.healthCheck();
console.log(JSON.stringify(health, null, 2));
if (!health.ok) {
  console.error('FAILED: provider health check');
  process.exit(1);
}

console.log('\n--- models ---');
const models = await provider.getModels();
console.log(models.slice(0, 8).map((m) => `${m.id} — ${m.label}`).join('\n'));

const core = new AppCore({ storage: new InMemoryStorage(), provider });
await core.init();
await core.updateSettings({ autoApproveAll: true });

const team = await core.createTeamFromPreset({ presetId: 'solo', name: 'Smoke', workspace });
const agent = team.agents[0];
await core.updateAgentModel(agent.id, 'haiku');
await core.updateAgentEffort(agent.id, 'low');

core.subscribe((e) => {
  if (e.type === 'run.event') {
    const ev = e.event;
    if (['agent_started', 'tool_call', 'agent_stopped', 'run_completed', 'error'].includes(ev.type)) {
      console.log(`[${ev.type}] ${ev.summary}`);
    }
  }
});

console.log('\n--- run ---');
const run = await core.startRun({
  teamId: team.id,
  objective:
    'Read the file VERSION.txt in the working directory and report the version number it contains. Then call finish with the answer.',
  budget: { maxCostUsd: 1, maxDurationMinutes: 5, maxAgentActivations: 6 },
});
const finished = await core.waitForRun(run.id);

console.log('\n--- result ---');
console.log('status:', finished.status);
console.log('summary:', finished.summary);
console.log('error:', finished.error);
console.log('totals:', JSON.stringify(finished.totals));

const detail = await core.getRunDetail(run.id);
console.log('tasks:', detail.tasks.map((t) => `${t.status} ${t.title}`).join(' | ') || '(none)');
console.log('models used:', detail.run.agentConfigSnapshot.map((s) => `${s.handle}=${s.model}/${s.effort}`).join(', '));

const mentionedVersion = (finished.summary ?? '').includes('7.3.1');
console.log('\nfound the version in the summary:', mentionedVersion);

await core.shutdown();
process.exit(finished.status === 'completed' && mentionedVersion ? 0 : 1);
