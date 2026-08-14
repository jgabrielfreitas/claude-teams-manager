import type { Storage } from '@claude-team/persistence';

/**
 * Cross-entity search, shared by the TUI's `/` and the web command palette.
 *
 * Small data sets, so a straightforward scored substring scan beats an index:
 * it needs no migration, ranks predictably, and stays honest about what matched.
 */

export type SearchKind = 'team' | 'agent' | 'run' | 'task' | 'message';

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  /** Higher is better. */
  score: number;
  /** Ids needed to navigate to the hit. */
  teamId?: string;
  runId?: string;
  agentId?: string;
}

function score(haystack: string | undefined, needle: string, weight: number): number {
  if (!haystack) return 0;
  const text = haystack.toLowerCase();
  const index = text.indexOf(needle);
  if (index === -1) return 0;
  // Exact match beats prefix beats substring.
  if (text === needle) return weight * 3;
  if (index === 0) return weight * 2;
  return weight;
}

export async function search(storage: Storage, query: string, limit = 50): Promise<SearchHit[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const hits: SearchHit[] = [];

  const [teams, agents, runs] = await Promise.all([
    storage.teams.list(),
    storage.agents.listAll(),
    storage.runs.list({ limit: 200 }),
  ]);

  for (const team of teams) {
    const s = score(team.name, needle, 10) + score(team.description, needle, 3) + score(team.id, needle, 8);
    if (s > 0) {
      hits.push({
        kind: 'team',
        id: team.id,
        title: team.name,
        subtitle: team.description ?? 'Team',
        score: s,
        teamId: team.id,
      });
    }
  }

  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  for (const agent of agents) {
    const s =
      score(agent.name, needle, 10) +
      score(agent.handle, needle, 10) +
      score(agent.role, needle, 6) +
      score(agent.description, needle, 3) +
      score(agent.model, needle, 2) +
      score(agent.id, needle, 8);
    if (s > 0) {
      hits.push({
        kind: 'agent',
        id: agent.id,
        title: `${agent.handle} — ${agent.name}`,
        subtitle: `${agent.role} · ${teamName.get(agent.teamId) ?? 'team'} · ${agent.model}/${agent.effort}`,
        score: s,
        teamId: agent.teamId,
        agentId: agent.id,
      });
    }
  }

  for (const run of runs) {
    const s = score(run.objective, needle, 8) + score(run.id, needle, 8) + score(run.summary, needle, 4);
    if (s > 0) {
      hits.push({
        kind: 'run',
        id: run.id,
        title: run.objective.split('\n')[0],
        subtitle: `${run.status} · ${teamName.get(run.teamId) ?? 'team'} · ${run.createdAt.toISOString().slice(0, 16).replace('T', ' ')}`,
        score: s,
        teamId: run.teamId,
        runId: run.id,
      });
    }
  }

  // Tasks and messages only for the most recent runs, to keep this bounded.
  for (const run of runs.slice(0, 25)) {
    const [tasks, messages] = await Promise.all([
      storage.tasks.listByRun(run.id),
      storage.messages.list({ runId: run.id, limit: 300 }),
    ]);

    for (const task of tasks) {
      const s = score(task.title, needle, 8) + score(task.description, needle, 3) + score(task.result, needle, 2);
      if (s > 0) {
        hits.push({
          kind: 'task',
          id: task.id,
          title: task.title,
          subtitle: `${task.status} · run ${run.id}`,
          score: s,
          runId: run.id,
          teamId: run.teamId,
          agentId: task.assignedAgentId,
        });
      }
    }

    for (const message of messages) {
      const s = score(message.content, needle, 4);
      if (s > 0) {
        hits.push({
          kind: 'message',
          id: message.id,
          title: `#${message.seq} ${message.type}`,
          subtitle: message.content.split('\n')[0].slice(0, 120),
          score: s,
          runId: run.id,
          teamId: run.teamId,
        });
      }
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
