/**
 * Smoke test of real multi-agent orchestration against the Claude provider.
 *
 * Verifies the thing that cannot be proved with the fake provider: that a real
 * orchestrator understands the team tools and actually delegates, that the
 * worker runs with ITS OWN model and effort, and that agent-to-agent messages
 * flow. Deliberately tiny and budget-capped.
 *
 *   pnpm tsx scripts/smoke-team.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@claude-team/persistence';
import { ClaudeProvider } from '@claude-team/provider';
import { AppCore } from '@claude-team/core';

const workspace = mkdtempSync(join(tmpdir(), 'ct-team-smoke-'));
writeFileSync(join(workspace, 'PRICES.txt'), 'widget=42\ngadget=17\n');
writeFileSync(join(workspace, 'STOCK.txt'), 'widget=3\ngadget=10\n');

const core = new AppCore({ storage: new InMemoryStorage(), provider: new ClaudeProvider() });
await core.init();
await core.updateSettings({ autoApproveAll: true });

const team = await core.createTeam({ name: 'Smoke Team', workspace });

const lead = await core.createAgentFromTemplate({
  teamId: team.id,
  templateId: 'tech-lead',
  handle: 'lead',
  model: 'sonnet',
  effort: 'medium',
});
const analyst = await core.createAgentFromTemplate({
  teamId: team.id,
  templateId: 'data-analyst',
  handle: 'analyst',
  model: 'haiku',
  effort: 'low',
});
await core.updateTeam(team.id, { orchestratorId: lead.id });

console.log('team:', team.name);
console.log('  lead    ', lead.model, lead.effort);
console.log('  analyst ', analyst.model, analyst.effort);

core.subscribe((e) => {
  if (e.type !== 'run.event') return;
  const ev = e.event;
  if (
    ['agent_started', 'task_created', 'task_assigned', 'task_completed', 'message_sent', 'run_completed', 'error'].includes(
      ev.type,
    )
  ) {
    console.log(`[${ev.type}] ${ev.summary}`);
  }
});

const run = await core.startRun({
  teamId: team.id,
  objective:
    'The working directory contains PRICES.txt and STOCK.txt. Delegate to the analyst the job of ' +
    'reading both files and computing the total inventory value (price x stock, summed). ' +
    'Then report the total. Do not do the reading yourself.',
  budget: { maxCostUsd: 3, maxDurationMinutes: 8, maxAgentActivations: 8 },
});

const finished = await core.waitForRun(run.id);
const detail = await core.getRunDetail(run.id);

console.log('\n--- result ---');
console.log('status  :', finished.status);
console.log('summary :', finished.summary);
console.log('error   :', finished.error);
console.log('cost    : $' + finished.totals.costUsd.toFixed(4));
console.log('tasks   :');
for (const t of detail.tasks) {
  const assignee = detail.agents.find((a) => a.id === t.assignedAgentId)?.handle ?? '—';
  console.log(`   [${t.status}] "${t.title}" → ${assignee}`);
}
console.log('activations:');
for (const ev of detail.events.filter((e) => e.type === 'agent_started')) {
  const handle = detail.agents.find((a) => a.id === ev.agentId)?.handle;
  console.log(`   ${handle} on ${ev.model}/${ev.effort}`);
}
console.log('messages:', detail.messages.length);

const delegated = detail.tasks.length > 0;
const analystRan = detail.events.some(
  (e) => e.type === 'agent_started' && e.agentId === analyst.id,
);
const analystUsedOwnModel = detail.events.some(
  (e) => e.type === 'agent_started' && e.agentId === analyst.id && e.model === 'haiku',
);
// 42 x 3 + 17 x 10 = 296
const correct = /296/.test(finished.summary ?? '');

console.log('\nchecks:');
console.log('  orchestrator delegated      :', delegated);
console.log('  worker actually ran         :', analystRan);
console.log('  worker used its OWN model   :', analystUsedOwnModel);
console.log('  total is correct (expect 296):', correct);
console.log('  run completed               :', finished.status === 'completed');

await core.shutdown();
process.exit(
  delegated && analystRan && analystUsedOwnModel && correct && finished.status === 'completed' ? 0 : 1,
);
