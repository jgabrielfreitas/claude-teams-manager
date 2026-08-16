import { Link } from 'react-router-dom';
import type { DashboardDto } from '@claude-team/protocol';
import { formatRelative, truncate } from '@claude-team/ui-shared';
import { client } from '../api';
import { AgentAvatar } from '../components/agent-views';
import { LiveRunProgress, Timeline } from '../components/run-views';
import { Async, Card, EmptyState, Stat, StatusPill } from '../components/ui';
import { useResource } from '../hooks/use-resource';
import { runStatusUi, toneClass } from '../lib/tone';
import { useQuestions } from '../state/questions';

/**
 * The overview screen. Everything on it comes from one core call
 * (`getDashboard`) and refreshes when the event stream says something moved.
 */
export function DashboardPage() {
  const dashboard = useResource<DashboardDto>(
    () => client.getDashboard(),
    [],
    (event) => event.type !== 'notice',
  );
  const { open: openQuestion } = useQuestions();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <div className="page-sub">Teams, runs and everything happening right now.</div>
        </div>
        <div className="actions">
          <Link className="btn" to="/teams?new=preset">
            New team from preset
          </Link>
          <Link className="btn btn-primary" to="/teams">
            Start a run
          </Link>
        </div>
      </div>

      <Async resource={dashboard}>
        {(data) => (
          <>
            <div className="grid cols-4">
              <Stat label="Teams" value={data.counts.teams} />
              <Stat
                label="Agents"
                value={data.counts.agents}
                hint={`${data.counts.runningAgents} busy`}
              />
              <Stat
                label="Runs"
                value={data.counts.runs}
                hint={`${data.activeRuns.length} active`}
              />
              <Stat
                label="Waiting on you"
                value={data.pendingApprovals.length + data.pendingQuestions.length}
                hint={
                  data.pendingApprovals.length + data.pendingQuestions.length
                    ? `${data.pendingApprovals.length} approval(s) · ${data.pendingQuestions.length} question(s)`
                    : 'nothing waiting'
                }
              />
            </div>

            {(data.pendingApprovals.length > 0 || data.pendingQuestions.length > 0) && (
              <div
                className={`grid${
                  data.pendingApprovals.length > 0 && data.pendingQuestions.length > 0
                    ? ' cols-2'
                    : ''
                }`}
              >
                {data.pendingApprovals.length > 0 && (
                  <Card title="Pending approvals">
                    <p className="tiny muted" style={{ marginBottom: 8 }}>
                      An agent wants permission to do something.
                    </p>
                    <div className="col">
                      {data.pendingApprovals.map((approval) => (
                        <div key={approval.id} className="spread">
                          <span className="truncate">{approval.summary}</span>
                          <Link className="btn btn-sm" to={`/runs/${approval.runId}`}>
                            Open run
                          </Link>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}

                {data.pendingQuestions.length > 0 && (
                  <Card title="Questions for you" className="tone-info">
                    <p className="tiny muted" style={{ marginBottom: 8 }}>
                      An agent is blocked until you decide — a permission will not unblock it.
                    </p>
                    <div className="col" style={{ gap: 10 }}>
                      {data.pendingQuestions.map((question) => (
                        <div key={question.id} className="spread">
                          <span className="col" style={{ gap: 2, minWidth: 0 }}>
                            <span className="strong truncate">{question.header || 'Question'}</span>
                            <span className="tiny muted truncate">
                              {truncate(question.question, 90)}
                            </span>
                          </span>
                          <span className="row right" style={{ gap: 6 }}>
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              onClick={() => openQuestion(question.id)}
                            >
                              Answer
                            </button>
                            <Link className="btn btn-sm" to={`/runs/${question.runId}`}>
                              Open run
                            </Link>
                          </span>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
              </div>
            )}

            <div className="grid main-aside">
              <div className="col" style={{ gap: 20 }}>
                <Card
                  title="Active runs"
                  actions={
                    <Link className="btn btn-sm btn-ghost" to="/runs">
                      All runs
                    </Link>
                  }
                  flush
                >
                  {data.activeRuns.length === 0 ? (
                    <EmptyState
                      title="Nothing running"
                      description="Start a run from a team to watch your agents work in real time."
                    />
                  ) : (
                    <div className="list">
                      {data.activeRuns.map((run) => (
                        <Link key={run.id} className="list-item" to={`/runs/${run.id}`}>
                          <StatusPill status={runStatusUi(run.status)} />
                          <span className="col" style={{ gap: 4, flex: 1 }}>
                            <span className="truncate">{truncate(run.objective, 90)}</span>
                            <LiveRunProgress
                              runId={run.id}
                              status={run.status}
                              initial={data.progress?.[run.id]}
                            />
                          </span>
                          <span className="tiny muted nowrap">
                            {run.totals.agentActivations} activations
                          </span>
                        </Link>
                      ))}
                    </div>
                  )}
                </Card>

                <Card
                  title="Teams"
                  actions={
                    <Link className="btn btn-sm btn-ghost" to="/teams">
                      Manage
                    </Link>
                  }
                  flush
                >
                  {data.teams.length === 0 ? (
                    <EmptyState
                      title="No teams yet"
                      description="Create one from a preset to get a competent team in a couple of clicks."
                      action={
                        <Link className="btn btn-primary" to="/teams?new=preset">
                          Create a team
                        </Link>
                      }
                    />
                  ) : (
                    <div className="list">
                      {data.teams.map((team) => (
                        <div key={team.id} className="list-item">
                          <Link
                            className="col"
                            style={{ gap: 2, minWidth: 160 }}
                            to={`/teams/${team.id}`}
                          >
                            <span className="strong truncate">{team.name}</span>
                            <span className="tiny muted truncate">
                              {team.agents.length} agents
                              {team.workspace ? ` · ${team.workspace}` : ''}
                            </span>
                          </Link>
                          <div className="row right" style={{ gap: 6 }}>
                            {team.agents.map((agent) => (
                              <AgentAvatar key={agent.id} agent={agent} />
                            ))}
                          </div>
                          {team.activeRunId && (
                            <Link className="btn btn-sm" to={`/runs/${team.activeRunId}`}>
                              Live run
                            </Link>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>

              <div className="col" style={{ gap: 20 }}>
                <Card
                  title="Recent activity"
                  actions={
                    <Link className="btn btn-sm btn-ghost" to="/activity">
                      All
                    </Link>
                  }
                  flush
                >
                  <Timeline
                    events={[...data.recentEvents].reverse().slice(0, 40)}
                    agents={data.teams.flatMap((t) => t.agents)}
                    emptyLabel="Nothing has happened yet."
                  />
                </Card>

                <Card title="Recent runs" flush>
                  {data.recentRuns.length === 0 ? (
                    <EmptyState title="No runs yet" />
                  ) : (
                    <div className="list">
                      {data.recentRuns.map((run) => {
                        const ui = runStatusUi(run.status);
                        return (
                          <Link
                            key={run.id}
                            className={`list-item ${toneClass(ui.tone)}`}
                            to={`/runs/${run.id}`}
                          >
                            <span className={`dot${ui.busy ? ' busy' : ''}`} />
                            <span className="truncate">{truncate(run.objective, 60)}</span>
                            <span className="tiny muted right nowrap">
                              {formatRelative(run.createdAt)}
                            </span>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </Card>
              </div>
            </div>
          </>
        )}
      </Async>
    </>
  );
}
