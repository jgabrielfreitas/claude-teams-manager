import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { slugify, toPortableTeam, type Agent, type Team } from '@claude-team/domain';

/**
 * The teams folder: a plain-file mirror of every team you have.
 *
 * Rationale: the SQLite database is an implementation detail and is per-machine
 * state, but a *team* is a thing you want to review, diff, commit and hand to a
 * colleague. So every team is also kept on disk as the portable YAML from
 * `docs/team-format.md`, rewritten whenever the team's shape changes.
 *
 * This is a mirror, not a source of truth: the database wins. Editing a file
 * here does nothing until you `team import` it — which is deliberate, because
 * an editor auto-save should never silently reconfigure a running team.
 */

export interface TeamFileWrite {
  path: string;
  teamId: string;
}

/** Filename for a team, stable across renames of unrelated teams. */
export function teamFileName(team: Pick<Team, 'id' | 'name'>): string {
  const slug = slugify(team.name) || 'team';
  return `${slug}.${team.id}.yaml`;
}

/**
 * Default location: `<claude-team home>/teams`, derived from wherever the
 * database lives so the two always travel together.
 */
export function defaultTeamsDir(databaseLocation: string): string | undefined {
  if (!databaseLocation || databaseLocation === ':memory:') return undefined;
  return join(dirname(databaseLocation), 'teams');
}

export function writeTeamFile(dir: string, team: Team, agents: Agent[]): TeamFileWrite {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, teamFileName(team));
  const doc = stripUndefinedDeep(toPortableTeam(team, agents));
  const header = [
    `# ${team.name}`,
    '#',
    '# Written automatically by claude-team whenever this team changes.',
    '# Safe to commit. Import elsewhere with:',
    `#   claude-team team import ${teamFileName(team)}`,
    '#',
    '# Editing this file does NOT change the team — import it to apply.',
    '',
  ].join('\n');
  writeFileSync(path, `${header}${stringifyYaml(doc, { lineWidth: 100 })}`, 'utf8');
  return { path, teamId: team.id };
}

/** Removes a team's file, including one written under a previous name. */
export function removeTeamFile(dir: string, team: Pick<Team, 'id' | 'name'>): void {
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith(`.${team.id}.yaml`)) rmSync(join(dir, entry), { force: true });
    }
  } catch {
    // No directory yet, or it is not readable: nothing to clean up.
  }
}

/** Drops stale files left behind when a team was renamed. */
export function pruneRenamedFiles(dir: string, team: Pick<Team, 'id' | 'name'>): void {
  const keep = teamFileName(team);
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith(`.${team.id}.yaml`) && entry !== keep) {
        rmSync(join(dir, entry), { force: true });
      }
    }
  } catch {
    /* nothing written yet */
  }
}

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefinedDeep) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefinedDeep(v);
    }
    return out as T;
  }
  return value;
}
