/**
 * Smoke test of "reuse my local Claude Code setup" against the REAL provider.
 *
 * The setting is worth nothing unless the agent can actually see the memory and
 * the skills the machine already has, so this proves both halves: the same team,
 * on the same objective, run twice — isolated, then inheriting the workspace —
 * and only the second one knows the codename or can name the skill.
 *
 *   pnpm smoke:local
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@claude-team/persistence';
import { ClaudeProvider } from '@claude-team/provider';
import { AppCore } from '@claude-team/core';

const CODENAME = 'PEIXE-AZUL-7731';

const workspace = mkdtempSync(join(tmpdir(), 'ct-local-'));
writeFileSync(
  join(workspace, 'CLAUDE.md'),
  [
    '# Project instructions',
    '',
    `The internal codename of this project is ${CODENAME}.`,
    'Whenever you are asked about the codename, answer with it exactly.',
    '',
  ].join('\n'),
);

const skillDir = join(workspace, '.claude', 'skills', 'relatorio-semanal');
mkdirSync(skillDir, { recursive: true });
writeFileSync(
  join(skillDir, 'SKILL.md'),
  [
    '---',
    'name: relatorio-semanal',
    'description: Formato oficial do relatório semanal deste projeto.',
    '---',
    '',
    'The weekly report always has exactly three sections: Feito, Em curso, Riscos.',
    '',
  ].join('\n'),
);

const OBJECTIVE =
  'Answer in one short paragraph, without using any tool: what is the internal codename ' +
  'of this project, and do you have a skill for the weekly report format? If you do not ' +
  'know either of them, say plainly that you do not know.';

async function attempt(label: string, localSetup: Record<string, unknown>) {
  const core = new AppCore({ storage: new InMemoryStorage(), provider: new ClaudeProvider() });
  await core.init();
  await core.updateSettings({ autoApproveAll: true, autoAnswerQuestions: true, localSetup });

  const team = await core.createTeamFromPreset({ presetId: 'solo', name: label, workspace });
  await core.updateAgentModel(team.agents[0].id, 'sonnet');
  await core.updateAgentEffort(team.agents[0].id, 'low');

  const run = await core.startRun({
    teamId: team.id,
    objective: OBJECTIVE,
    budget: { maxCostUsd: 1, maxDurationMinutes: 5, maxAgentActivations: 3 },
  });
  const finished = await core.waitForRun(run.id);
  const detail = await core.getRunDetail(run.id);
  const text = [finished.summary ?? '', ...detail.events.map((e) => String(e.data?.text ?? ''))].join('\n');

  await core.shutdown();
  return { status: finished.status, cost: finished.totals.costUsd, text };
}

console.log('workspace:', workspace, '\n');

const isolated = await attempt('Isolated', { settingSources: [], skills: 'none', mcpServers: false });
console.log('--- isolated ---');
console.log('status  :', isolated.status, '· $' + isolated.cost.toFixed(4));
console.log('knows codename:', isolated.text.includes(CODENAME));
console.log('knows skill   :', /relatorio-semanal|Em curso/i.test(isolated.text));

const inherited = await attempt('Inherited', {
  settingSources: ['user', 'project'],
  skills: 'all',
  mcpServers: false,
});
console.log('\n--- inheriting this machine ---');
console.log('status  :', inherited.status, '· $' + inherited.cost.toFixed(4));
console.log('knows codename:', inherited.text.includes(CODENAME));
console.log('knows skill   :', /relatorio-semanal|Em curso/i.test(inherited.text));
console.log('\nsaid:', inherited.text.replace(/\s+/g, ' ').slice(0, 400));

const ok =
  isolated.status === 'completed' &&
  inherited.status === 'completed' &&
  !isolated.text.includes(CODENAME) &&
  inherited.text.includes(CODENAME);

console.log('\nchecks:');
console.log('  isolated run cannot see the workspace memory :', !isolated.text.includes(CODENAME));
console.log('  inheriting run reads CLAUDE.md               :', inherited.text.includes(CODENAME));
console.log('  inheriting run is offered the local skill    :', /relatorio-semanal|Em curso/i.test(inherited.text));

process.exit(ok ? 0 : 1);
