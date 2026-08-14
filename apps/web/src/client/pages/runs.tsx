import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDuration, formatRelative, runDurationMs, truncate } from '@claude-team/ui-shared';
import { formatUsd } from '@claude-team/domain';
import { client } from '../api';
import { LiveRunProgress } from '../components/run-views';
import { Async, Card, EmptyState, StatusPill } from '../components/ui';
import { useResource } from '../hooks/use-resource';
import { runStatusUi } from '../lib/tone';

/** Every run, newest first. */
export function RunsPage() {
  const [teamId, setTeamId] = useState('');

  const teams = useResource(() => client.listTeams(), [], (event) => event.type === 'team.changed');
  const runs = useResource(
    () => client.listRuns(teamId || undefined),
    [teamId],
    (event) => event.type === 'run.created' || event.type === 'run.status',
  );

  const teamName = (id: string) => teams.data?.find((team) => team.id === id)?.name ?? id;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Runs</h1>
          <div className="page-sub">Each run records the objective, the plan and every decision.</div>
        </div>
        <div className="actions">
          <select
            className="select"
            style={{ width: 200 }}
            value={teamId}
            onChange={(event) => setTeamId(event.target.value)}
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

      <Async resource={runs}>
        {(list) =>
          list.length === 0 ? (
            <Card>
              <EmptyState
                title="No runs yet"
                description="Open a team and start one — you will see the plan, the agents and the timeline as it happens."
                action={
                  <Link className="btn btn-primary" to="/teams">
                    Go to teams
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
                      <th>Objective</th>
                      <th>Team</th>
                      <th>Status</th>
                      <th style={{ width: 180 }}>Progress</th>
                      <th>Cost</th>
                      <th>Duration</th>
                      <th>Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((run) => (
                      <tr key={run.id} className="clickable">
                        <td>
                          <Link to={`/runs/${run.id}`} className="strong">
                            {truncate(run.objective, 70)}
                          </Link>
                        </td>
                        <td className="small">
                          <Link to={`/teams/${run.teamId}`}>{teamName(run.teamId)}</Link>
                        </td>
                        <td>
                          <StatusPill status={runStatusUi(run.status)} />
                        </td>
                        <td>
                          <LiveRunProgress runId={run.id} status={run.status} />
                        </td>
                        <td className="small nowrap">{formatUsd(run.totals.costUsd)}</td>
                        <td className="small nowrap">{formatDuration(runDurationMs(run))}</td>
                        <td className="small nowrap muted">{formatRelative(run.createdAt)}</td>
                      </tr>
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
