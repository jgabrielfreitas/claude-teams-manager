/**
 * Smoke test of the ask-the-human path against the REAL Claude provider.
 *
 * Proves the fix for the failure seen in the field: an agent that needs a
 * decision from the human now raises a *question* (answered, and the answer
 * reaches the agent) instead of a *permission* prompt that grants nothing.
 *
 *   pnpm tsx scripts/smoke-question.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@claude-team/persistence';
import { ClaudeProvider } from '@claude-team/provider';
import { AppCore } from '@claude-team/core';

const workspace = mkdtempSync(join(tmpdir(), 'ct-question-'));

const core = new AppCore({ storage: new InMemoryStorage(), provider: new ClaudeProvider() });
await core.init();
await core.updateSettings({ autoApproveAll: true, autoAnswerQuestions: false });

const team = await core.createTeamFromPreset({ presetId: 'solo', name: 'Question Smoke', workspace });
const agent = team.agents[0];
await core.updateAgentModel(agent.id, 'sonnet');
await core.updateAgentEffort(agent.id, 'low');

let answered = false;

core.subscribe((event) => {
  if (event.type === 'run.event') {
    const e = event.event;
    if (['agent_started', 'tool_call', 'run_completed', 'error'].includes(e.type)) {
      console.log(`[${e.type}] ${e.summary}`);
    }
  }

  // The whole point: a question arrives as a question, and answering it
  // actually unblocks the agent.
  if (event.type === 'question' && event.question.status === 'pending') {
    const q = event.question;
    console.log('\n--- QUESTION RAISED ---');
    console.log('header :', q.header ?? '(none)');
    console.log('asks   :', q.question);
    console.log('options:', q.options.map((o) => o.label).join(' | ') || '(free text)');
    answered = true;
    const choice = q.options[0]?.label;
    void core
      .answerQuestion(
        choice ? { questionId: q.id, selected: [choice] } : { questionId: q.id, text: 'Weddings' },
      )
      .then(() => console.log('--- ANSWERED with:', choice ?? 'Weddings', '---\n'))
      .catch((err) => console.error('answer failed:', err.message));
  }
});

const run = await core.startRun({
  teamId: team.id,
  objective:
    'I want to build a longtail affiliate page but I have not decided the niche. ' +
    'Ask me which niche to target, offering 2 or 3 concrete options, and then write a ' +
    'one-paragraph plan for the niche I pick. Do not decide the niche yourself.',
  budget: { maxCostUsd: 2, maxDurationMinutes: 6, maxAgentActivations: 5 },
});

const finished = await core.waitForRun(run.id);
const detail = await core.getRunDetail(run.id);

console.log('--- result ---');
console.log('status    :', finished.status);
console.log('cost      : $' + finished.totals.costUsd.toFixed(4));
console.log('summary   :', (finished.summary ?? '').slice(0, 300));
console.log('questions :', detail.questions.map((q) => `${q.status} "${q.answer ?? ''}"`).join(' | ') || '(none)');
console.log('approvals :', detail.approvals.length, '(should be 0 — this is a question, not a permission)');

console.log('\nchecks:');
console.log('  agent raised a question       :', answered);
console.log('  it was answered               :', detail.questions.some((q) => q.status === 'answered'));
console.log('  no approval prompt was raised :', detail.approvals.length === 0);
console.log('  run completed                 :', finished.status === 'completed');

await core.shutdown();
process.exit(
  answered &&
    detail.questions.some((q) => q.status === 'answered') &&
    detail.approvals.length === 0 &&
    finished.status === 'completed'
    ? 0
    : 1,
);
