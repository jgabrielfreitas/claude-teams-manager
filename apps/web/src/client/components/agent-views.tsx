import { Link } from 'react-router-dom';
import type { AgentDto } from '@claude-team/protocol';
import { agentStatusUi, toneClass } from '../lib/tone';
import { EffortBadge, ModelBadge, StatusPill } from './ui';

/** Two-letter mark, coloured by the agent's live status. */
export function AgentAvatar({ agent }: { agent: AgentDto }) {
  const ui = agentStatusUi(agent.status);
  return (
    <span className={`avatar ${toneClass(ui.tone)}`} title={`${agent.handle} — ${ui.label}`}>
      {agent.handle.slice(0, 2)}
    </span>
  );
}

/** The standard way an agent appears in a list: identity, model, effort, status. */
export function AgentCard({ agent, subtitle }: { agent: AgentDto; subtitle?: string }) {
  return (
    <Link className="agent-card" to={`/agents/${agent.id}`}>
      <AgentAvatar agent={agent} />
      <span className="col" style={{ gap: 1 }}>
        <span className="row" style={{ gap: 6 }}>
          <span className="strong truncate">{agent.handle}</span>
          <span className="tiny muted truncate">{agent.role}</span>
        </span>
        <span className="row" style={{ gap: 5 }}>
          <ModelBadge model={agent.model} />
          <EffortBadge effort={agent.effort} />
          {subtitle && <span className="tiny muted truncate">{subtitle}</span>}
        </span>
      </span>
      <span className="right">
        <StatusPill status={agentStatusUi(agent.status)} />
      </span>
    </Link>
  );
}

/** Compact inline reference to an agent, used inside dense rows. */
export function AgentInline({ agent }: { agent?: AgentDto }) {
  if (!agent) return <span className="muted">unassigned</span>;
  const ui = agentStatusUi(agent.status);
  return (
    <Link to={`/agents/${agent.id}`} className={`row ${toneClass(ui.tone)}`} style={{ gap: 6 }}>
      <span className={`dot${ui.busy ? ' busy' : ''}`} />
      <span className="strong">{agent.handle}</span>
    </Link>
  );
}
