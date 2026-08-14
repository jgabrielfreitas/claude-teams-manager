import { useState } from 'react';
import type { AgentDto } from '@claude-team/protocol';
import { client } from '../api';
import { Timeline } from '../components/run-views';
import { Async, Card } from '../components/ui';
import { useResource } from '../hooks/use-resource';

/** Everything that has happened recently, across every run. */
export function ActivityPage() {
  const [limit, setLimit] = useState(200);

  const activity = useResource(
    () => client.getActivity(limit),
    [limit],
    (event) => event.type === 'run.event',
  );
  const teams = useResource(() => client.listTeams(), [], (event) => event.type === 'team.changed');
  const agents: AgentDto[] = (teams.data ?? []).flatMap((team) => team.agents);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <div className="page-sub">The live event log, straight from the runtime.</div>
        </div>
        <div className="actions">
          <select
            className="select"
            value={limit}
            style={{ width: 140 }}
            onChange={(event) => setLimit(Number(event.target.value))}
          >
            <option value={100}>Last 100</option>
            <option value={200}>Last 200</option>
            <option value={500}>Last 500</option>
          </select>
        </div>
      </div>

      <Card flush>
        <Async resource={activity}>
          {(events) => (
            <Timeline
              events={[...events].reverse()}
              agents={agents}
              emptyLabel="Nothing has happened yet."
            />
          )}
        </Async>
      </Card>
    </>
  );
}
