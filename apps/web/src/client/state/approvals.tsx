import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentDto, ApprovalDto } from '@claude-team/protocol';
import { client } from '../api';
import { Modal } from '../components/ui';
import { useAppEvent } from './realtime';
import { useAction } from './toasts';

/**
 * Human-in-the-loop gate.
 *
 * An approval arrives on the event stream, interrupts whatever is on screen,
 * and the decision goes straight back to the core. The *rules* about what
 * needs approving live in the runtime; this only asks the question.
 */
export function ApprovalCenter() {
  const [queue, setQueue] = useState<ApprovalDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [agent, setAgent] = useState<AgentDto | undefined>();
  const act = useAction();

  useEffect(() => {
    void client
      .listApprovals()
      .then((pending) => setQueue((current) => merge(current, pending)))
      .catch(() => undefined);
  }, []);

  useAppEvent(
    (event) => {
      if (event.type !== 'approval') return;
      setQueue((current) =>
        event.approval.status === 'pending'
          ? merge(current, [event.approval])
          : current.filter((a) => a.id !== event.approval.id),
      );
    },
    (event) => event.type === 'approval',
  );

  const current = queue[0];

  // Who is asking, by handle rather than by id.
  useEffect(() => {
    if (!current) {
      setAgent(undefined);
      return;
    }
    let cancelled = false;
    void client
      .getAgent(current.agentId)
      .then((result) => !cancelled && setAgent(result))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [current?.agentId, current]);

  const decide = useCallback(
    async (decision: 'allow_once' | 'allow_always' | 'deny') => {
      if (!current) return;
      setBusy(true);
      const ok = await act(() => client.decideApproval(current.id, decision));
      setBusy(false);
      if (ok) setQueue((q) => q.filter((a) => a.id !== current.id));
    },
    [act, current],
  );

  if (!current) return null;

  return (
    <Modal
      title={
        <div className="col" style={{ gap: 2 }}>
          <h2 style={{ fontSize: 15 }}>Approval required</h2>
          <span className="tiny muted">
            {current.toolName} · {current.category}
          </span>
        </div>
      }
      onClose={() => void decide('deny')}
      dismissable={false}
      footer={
        <>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void decide('deny')}>
            Deny
          </button>
          <span className="right" />
          <button type="button" className="btn" disabled={busy} onClick={() => void decide('allow_always')}>
            Always for this run
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void decide('allow_once')}
          >
            Allow once
          </button>
        </>
      }
    >
      <div className="approval-summary">{current.summary}</div>

      <div className="row small muted">
        <span>
          Requested by{' '}
          {agent ? (
            <Link to={`/agents/${agent.id}`} className="strong">
              {agent.handle}
            </Link>
          ) : (
            <code>{current.agentId}</code>
          )}
          {agent && ` · ${agent.role} · ${agent.model}/${agent.effort}`}
        </span>
        <Link className="btn btn-sm btn-ghost right" to={`/runs/${current.runId}`}>
          Open run
        </Link>
      </div>

      {Object.keys(current.input ?? {}).length > 0 && (
        <div className="col" style={{ gap: 4 }}>
          <span className="label">Input</span>
          <pre className="yaml">{JSON.stringify(current.input, null, 2)}</pre>
        </div>
      )}

      {queue.length > 1 && (
        <div className="notice-box">{queue.length - 1} more approval(s) waiting behind this one.</div>
      )}
    </Modal>
  );
}

function merge(current: ApprovalDto[], incoming: ApprovalDto[]): ApprovalDto[] {
  const seen = new Set(current.map((a) => a.id));
  return [...current, ...incoming.filter((a) => !seen.has(a.id) && a.status === 'pending')];
}
