import {
  createApproval,
  type ApprovalDecision,
  type ApprovalRequest,
} from '@claude-team/domain';
import type { PermissionDecision, PermissionRequest } from '@claude-team/provider';
import type { Storage } from '@claude-team/persistence';
import type { EventRecorder } from './recorder.js';

/**
 * Human-in-the-loop gate.
 *
 * A provider asks; the gate persists the request, notifies the UIs, and parks
 * the agent until a human decides (or the request times out and is denied).
 * "Allow always" is scoped to the run and the category, which is what the
 * prompt promises — it never leaks into the next run.
 */
export class ApprovalGate {
  private readonly pending = new Map<
    string,
    { request: ApprovalRequest; resolve: (d: PermissionDecision) => void; timer: NodeJS.Timeout }
  >();
  private readonly blanketAllows = new Set<string>();

  constructor(
    private readonly runId: string,
    private readonly storage: Storage,
    private readonly recorder: EventRecorder,
    private readonly options: {
      autoApproveAll: boolean;
      timeoutMs: number;
      onApproval?: (approval: ApprovalRequest) => void;
    },
  ) {}

  /** Requests currently waiting for a human. */
  listPending(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  async request(req: PermissionRequest & { category: string }): Promise<PermissionDecision> {
    if (this.options.autoApproveAll) return { behavior: 'allow' };

    const blanketKey = `${req.agentId}:${req.category}`;
    if (this.blanketAllows.has(blanketKey)) return { behavior: 'allow' };

    const approval = createApproval({
      runId: this.runId,
      agentId: req.agentId,
      category: req.category,
      toolName: req.toolName,
      summary: req.summary,
      input: req.input,
      expiresAt: new Date(Date.now() + this.options.timeoutMs),
    });
    await this.storage.approvals.create(approval);

    await this.recorder.record({
      runId: this.runId,
      type: 'approval_requested',
      agentId: req.agentId,
      summary: `Approval needed: ${req.summary}`,
      level: 'warn',
      data: { approvalId: approval.id, category: req.category, toolName: req.toolName },
    });
    this.options.onApproval?.(approval);

    return await new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        void this.settle(approval.id, 'deny', 'timeout', 'No decision was made in time.');
      }, this.options.timeoutMs);
      // Do not keep the process alive just because an approval is pending.
      timer.unref?.();
      this.pending.set(approval.id, { request: approval, resolve, timer });
    });
  }

  /** Called by the application core when a human decides. */
  resolve(approvalId: string, decision: ApprovalDecision, decidedBy = 'user'): boolean {
    if (!this.pending.has(approvalId)) return false;
    void this.settle(approvalId, decision, decidedBy);
    return true;
  }

  /** Denies everything still waiting; used when a run is cancelled or ends. */
  async abandonAll(reason: string): Promise<void> {
    for (const id of [...this.pending.keys()]) {
      await this.settle(id, 'deny', 'system', reason);
    }
  }

  private async settle(
    approvalId: string,
    decision: ApprovalDecision,
    decidedBy: string,
    denyMessage = 'The human denied this action.',
  ): Promise<void> {
    const entry = this.pending.get(approvalId);
    if (!entry) return;
    this.pending.delete(approvalId);
    clearTimeout(entry.timer);

    if (decision === 'allow_always') {
      this.blanketAllows.add(`${entry.request.agentId}:${entry.request.category}`);
    }

    const updated: ApprovalRequest = {
      ...entry.request,
      status: 'resolved',
      decision,
      decidedBy,
      resolvedAt: new Date(),
    };
    await this.storage.approvals.update(updated);

    await this.recorder.record({
      runId: this.runId,
      type: 'approval_resolved',
      agentId: entry.request.agentId,
      summary: `Approval ${decision === 'deny' ? 'denied' : 'granted'}: ${entry.request.summary}`,
      level: decision === 'deny' ? 'warn' : 'info',
      data: { approvalId, decision, decidedBy },
    });
    this.options.onApproval?.(updated);

    entry.resolve(
      decision === 'deny' ? { behavior: 'deny', message: denyMessage } : { behavior: 'allow' },
    );
  }
}
