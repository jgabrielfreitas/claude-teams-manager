import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentDto, TeamWithAgentsDto } from '@claude-team/protocol';
import { client } from '../api';
import { AgentAvatar } from '../components/agent-views';
import { Async, Card, EffortBadge, EmptyState, ModelBadge, StatusPill } from '../components/ui';
import { useResource } from '../hooks/use-resource';
import { agentStatusUi } from '../lib/tone';

/** Every agent across every team, with the two settings that matter most. */
export function AgentsPage() {
  const teams = useResource<TeamWithAgentsDto[]>(
    () => client.listTeams(),
    [],
    (event) =>
      event.type === 'agent.changed' || event.type === 'agent.status' || event.type === 'team.changed',
  );

  const [query, setQuery] = useState('');
  const [teamFilter, setTeamFilter] = useState('');

  const rows = useMemo(() => {
    const all = (teams.data ?? []).flatMap((team) =>
      team.agents.map((agent) => ({ agent, team })),
    );
    const needle = query.trim().toLowerCase();
    return all.filter(
      ({ agent, team }) =>
        (!teamFilter || team.id === teamFilter) &&
        (!needle ||
          [agent.handle, agent.name, agent.role, agent.model].some((field) =>
            field.toLowerCase().includes(needle),
          )),
    );
  }, [teams.data, query, teamFilter]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agents</h1>
          <div className="page-sub">
            Each agent carries its own model, reasoning effort and permissions.
          </div>
        </div>
        <div className="actions">
          <input
            className="input"
            style={{ width: 200 }}
            value={query}
            placeholder="Filter agents…"
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            className="select"
            style={{ width: 180 }}
            value={teamFilter}
            onChange={(event) => setTeamFilter(event.target.value)}
          >
            <option value="">All teams</option>
            {(teams.data ?? []).map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Async resource={teams}>
        {() =>
          rows.length === 0 ? (
            <Card>
              <EmptyState
                title="No agents"
                description="Create a team from a preset, or add agents from templates."
                action={
                  <Link className="btn btn-primary" to="/teams?new=preset">
                    New team
                  </Link>
                }
              />
            </Card>
          ) : (
            <Card flush>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Team</th>
                      <th>Model</th>
                      <th>Effort</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ agent, team }) => (
                      <AgentRow key={agent.id} agent={agent} teamName={team.name} teamId={team.id} />
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )
        }
      </Async>
    </>
  );
}

function AgentRow({
  agent,
  teamName,
  teamId,
}: {
  agent: AgentDto;
  teamName: string;
  teamId: string;
}) {
  return (
    <tr className="clickable">
      <td>
        <Link className="row" to={`/agents/${agent.id}`} style={{ gap: 10 }}>
          <AgentAvatar agent={agent} />
          <span className="col" style={{ gap: 0 }}>
            <span className="strong">{agent.handle}</span>
            <span className="tiny muted">{agent.role}</span>
          </span>
        </Link>
      </td>
      <td>
        <Link className="small" to={`/teams/${teamId}`}>
          {teamName}
        </Link>
      </td>
      <td>
        <ModelBadge model={agent.model} />
      </td>
      <td>
        <EffortBadge effort={agent.effort} />
      </td>
      <td>
        <StatusPill status={agentStatusUi(agent.status)} />
      </td>
    </tr>
  );
}
