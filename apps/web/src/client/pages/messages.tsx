import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { truncate } from '@claude-team/ui-shared';
import { client } from '../api';
import { MessageThread } from '../components/run-views';
import { Async, Card, EmptyState } from '../components/ui';
import { useResource } from '../hooks/use-resource';
import { eventTouchesRun } from '@claude-team/protocol';
import { runStatusUi, toneClass } from '../lib/tone';

/** Agent-to-agent conversations, one run at a time. */
export function MessagesPage() {
  const runs = useResource(
    () => client.listRuns(),
    [],
    (event) => event.type === 'run.created' || event.type === 'run.status',
  );
  const [runId, setRunId] = useState('');

  useEffect(() => {
    if (!runId && runs.data?.[0]) setRunId(runs.data[0].id);
  }, [runs.data, runId]);

  const detail = useResource(
    () => (runId ? client.getRun(runId) : Promise.resolve(undefined)),
    [runId],
    (event) => Boolean(runId) && eventTouchesRun(event, runId),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Messages</h1>
          <div className="page-sub">
            Every question, answer and hand-off exchanged between your agents.
          </div>
        </div>
      </div>

      <Async resource={runs}>
        {(list) =>
          list.length === 0 ? (
            <Card>
              <EmptyState
                title="No runs yet"
                description="Messages belong to a run — start one to see the team talk."
                action={
                  <Link className="btn btn-primary" to="/teams">
                    Go to teams
                  </Link>
                }
              />
            </Card>
          ) : (
            <div className="grid main-aside">
              <Card
                title={detail.data ? truncate(detail.data.run.objective, 60) : 'Conversation'}
                actions={
                  runId && (
                    <Link className="btn btn-sm btn-ghost" to={`/runs/${runId}`}>
                      Open run
                    </Link>
                  )
                }
                flush
              >
                {detail.data ? (
                  <MessageThread messages={detail.data.messages} agents={detail.data.agents} />
                ) : (
                  <EmptyState title="Pick a run" />
                )}
              </Card>

              <Card title="Runs" flush>
                <div className="list">
                  {list.slice(0, 30).map((run) => {
                    const ui = runStatusUi(run.status);
                    return (
                      <button
                        key={run.id}
                        type="button"
                        className={`list-item ${toneClass(ui.tone)}`}
                        style={{
                          background: run.id === runId ? 'var(--surface-3)' : undefined,
                          border: 'none',
                          borderBottom: '1px solid var(--border)',
                          textAlign: 'left',
                          cursor: 'pointer',
                          width: '100%',
                        }}
                        onClick={() => setRunId(run.id)}
                      >
                        <span className={`dot ${ui.busy ? 'busy' : ''}`} />
                        <span className="truncate small">{truncate(run.objective, 48)}</span>
                      </button>
                    );
                  })}
                </div>
              </Card>
            </div>
          )
        }
      </Async>
    </>
  );
}
