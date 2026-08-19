/**
 * Smoke test of asking an agent something AFTER its run finished, against the
 * REAL provider.
 *
 * Proves the two halves of the fix: the message actually reaches the agent (it
 * used to be persisted and forgotten), and the agent answers from its own
 * session — the follow-up prompt never repeats the options, so a correct answer
 * can only come from remembering the run.
 *
 *   pnpm smoke:followup
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@claude-team/persistence';
import { ClaudeProvider } from '@claude-team/provider';
import { AppCore } from '@claude-team/core';

const workspace = mkdtempSync(join(tmpdir(), 'ct-followup-'));

const core = new AppCore({ storage: new InMemoryStorage(), provider: new ClaudeProvider() });
await core.init();
await core.updateSettings({ autoApproveAll: true, autoAnswerQuestions: true });

const team = await core.createTeamFromPreset({ presetId: 'solo', name: 'Follow-up', workspace });
const agent = team.agents[0]!;
await core.updateAgentModel(agent.id, 'sonnet');
await core.updateAgentEffort(agent.id, 'low');

core.subscribe((event) => {
  if (event.type === 'run.event' && ['agent_started', 'agent_output', 'error'].includes(event.event.type)) {
    console.log(`[${event.event.type}] ${event.event.summary.slice(0, 120)}`);
  }
});

const run = await core.startRun({
  teamId: team.id,
  objective:
    'Escolha UM codinome para este projeto entre exatamente estas três opções: TATU, JACARE, ARARA. ' +
    'Responda em uma linha dizendo qual escolheu e por quê. Não use ferramentas.',
  budget: { maxCostUsd: 1, maxDurationMinutes: 5, maxAgentActivations: 3 },
});

const finished = await core.waitForRun(run.id);
const before = await core.getRunDetail(run.id);
const said = before.events
  .filter((e) => e.type === 'agent_output')
  .map((e) => String(e.data?.text ?? ''))
  .join('\n');
const chosen = ['TATU', 'JACARE', 'ARARA'].find((name) => said.toUpperCase().includes(name));

console.log('\n--- run ---');
console.log('status :', finished.status, '· $' + finished.totals.costUsd.toFixed(4));
console.log('chose  :', chosen ?? '(could not tell)');

// The follow-up deliberately does not name the options.
console.log('\n--- asking after it finished ---');
await core.sendAgentMessage({
  runId: run.id,
  from: 'user',
  to: [agent.id],
  content: 'Qual codinome você escolheu? Responda só com a palavra, em maiúsculas.',
});
await core.waitForReply(run.id);

const after = await core.getRunDetail(run.id);
const reply = after.messages.filter((m) => m.type === 'answer' && m.to.includes('user')).at(-1);
const mine = after.messages.find((m) => m.from === 'user');
const stillCompleted = (await core.getRun(run.id)).status === 'completed';

console.log('reply       :', reply?.content?.slice(0, 200) ?? '(none)');
console.log('my message  :', mine?.status);
console.log('run status  :', (await core.getRun(run.id)).status);
console.log('cost now    : $' + (await core.getRun(run.id)).totals.costUsd.toFixed(4));

const remembered = Boolean(chosen && reply?.content.toUpperCase().includes(chosen));

console.log('\nchecks:');
console.log('  the agent answered at all        :', Boolean(reply));
console.log('  it remembered its own choice     :', remembered);
console.log('  my message was marked handled    :', mine?.status === 'completed');
console.log('  the finished run stayed finished  :', stillCompleted);

await core.shutdown();
process.exit(reply && remembered && mine?.status === 'completed' && stillCompleted ? 0 : 1);
