import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AppCore } from '@claude-team/core';
import { shortModelLabel } from '@claude-team/domain';
import { AGENT_STATUS_UI, EFFORT_UI, RUN_STATUS_UI, formatRelative, truncate } from '@claude-team/ui-shared';

/**
 * Non-interactive subcommands. Each one is a thin shell around `AppCore`:
 * resolve the reference the user typed, call the core, print the result.
 */

function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value.padEnd(width);
}

export async function teamList(core: AppCore): Promise<number> {
  const teams = await core.listTeams();
  if (teams.length === 0) {
    process.stdout.write('No teams yet. Run `claude-team` to create one.\n');
    return 0;
  }
  process.stdout.write(
    `${pad('ID', 14)}${pad('NAME', 26)}${pad('AGENTS', 7)}${pad('ORCHESTRATOR', 16)}WORKSPACE\n`,
  );
  for (const team of teams) {
    const orchestrator = team.agents.find((agent) => agent.id === team.orchestratorId)?.handle ?? '—';
    process.stdout.write(
      `${pad(team.id, 14)}${pad(team.name, 26)}${pad(String(team.agents.length), 7)}${pad(orchestrator, 16)}${
        team.workspace ?? '—'
      }\n`,
    );
  }
  return 0;
}

export async function agentList(core: AppCore): Promise<number> {
  const teams = await core.listTeams();
  const rows = teams.flatMap((team) => team.agents.map((agent) => ({ team, agent })));
  if (rows.length === 0) {
    process.stdout.write('No agents yet. Run `claude-team` to create a team.\n');
    return 0;
  }
  process.stdout.write(
    `${pad('TEAM', 20)}${pad('HANDLE', 16)}${pad('ROLE', 24)}${pad('MODEL', 10)}${pad('EFFORT', 8)}STATUS\n`,
  );
  for (const { team, agent } of rows) {
    process.stdout.write(
      `${pad(team.name, 20)}${pad(agent.handle, 16)}${pad(agent.role, 24)}${pad(
        shortModelLabel(agent.model),
        10,
      )}${pad(EFFORT_UI[agent.effort].label, 8)}${AGENT_STATUS_UI[agent.status].label}\n`,
    );
  }
  return 0;
}

export async function teamExport(core: AppCore, ref: string): Promise<number> {
  const team = await core.findTeam(ref);
  process.stdout.write(await core.exportTeam(team.id));
  return 0;
}

export async function teamImport(core: AppCore, file: string): Promise<number> {
  const path = resolve(file);
  const yaml = await readFile(path, 'utf8');
  const { team, warnings } = await core.importTeam(yaml);
  process.stdout.write(`Imported "${team.name}" (${team.id}) with ${team.agents.length} agent(s).\n`);
  for (const agent of team.agents) {
    process.stdout.write(
      `  ${agent.handle.padEnd(16)}${agent.role.padEnd(24)}${shortModelLabel(agent.model)}/${agent.effort}\n`,
    );
  }
  for (const warning of warnings) process.stdout.write(`  warning: ${warning}\n`);
  return 0;
}

export async function runList(core: AppCore): Promise<number> {
  const runs = await core.listRuns({ limit: 30 });
  if (runs.length === 0) {
    process.stdout.write('No runs yet.\n');
    return 0;
  }
  for (const run of runs) {
    process.stdout.write(
      `${pad(run.id, 16)}${pad(RUN_STATUS_UI[run.status].label, 11)}${pad(formatRelative(run.createdAt), 12)}${truncate(
        run.objective,
        60,
      )}\n`,
    );
  }
  return 0;
}
