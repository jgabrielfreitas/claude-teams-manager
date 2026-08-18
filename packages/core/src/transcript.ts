import {
  EFFORT_CATALOG,
  addUsage,
  describeBudget,
  emptyUsage,
  formatTokens,
  formatUsd,
  isTaskTerminal,
  shortModelLabel,
  totalTokens,
  type Agent,
  type AgentMessage,
  type AgentQuestion,
  type Run,
  type RunEvent,
  type Task,
  type Team,
} from '@claude-team/domain';

/**
 * The full transcript of a run, as text.
 *
 * Rendered here rather than in either UI so that the timeline a user copies out
 * of the terminal and the one they download from the browser are the *same
 * document* — an exported run is an artefact people paste into issues and share
 * with colleagues, so it must not depend on where it was produced (ADR-001).
 */

export const TRANSCRIPT_FORMATS = ['markdown', 'text', 'json'] as const;
export type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];

export interface TranscriptInput {
  run: Run;
  team: Team;
  agents: Agent[];
  tasks: Task[];
  messages: AgentMessage[];
  events: RunEvent[];
  /** Questions the agents put to the human, and what was answered. */
  questions?: AgentQuestion[];
}

export interface TranscriptOptions {
  format?: TranscriptFormat;
  /** Include `debug`-level events (thinking, tool traffic). Off by default. */
  includeDebug?: boolean;
  /** Include the full text of agent messages. On by default. */
  includeMessages?: boolean;
}

export function transcriptFileName(run: Run, format: TranscriptFormat): string {
  const stamp = (run.startedAt ?? run.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const ext = format === 'json' ? 'json' : format === 'markdown' ? 'md' : 'txt';
  return `run-${run.id}-${stamp}.${ext}`;
}

export function transcriptMimeType(format: TranscriptFormat): string {
  switch (format) {
    case 'json':
      return 'application/json; charset=utf-8';
    case 'markdown':
      return 'text/markdown; charset=utf-8';
    default:
      return 'text/plain; charset=utf-8';
  }
}

export function formatTranscript(input: TranscriptInput, options: TranscriptOptions = {}): string {
  const format = options.format ?? 'markdown';
  if (format === 'json') return jsonTranscript(input, options);
  return format === 'markdown' ? markdownTranscript(input, options) : textTranscript(input, options);
}

/* ------------------------------------------------------------------ *
 * Shared derivations
 * ------------------------------------------------------------------ */

function handleOf(input: TranscriptInput, id: string | undefined): string {
  if (!id) return '—';
  if (id === 'user') return 'user';
  return input.agents.find((a) => a.id === id)?.handle ?? id;
}

function visibleEvents(input: TranscriptInput, options: TranscriptOptions): RunEvent[] {
  const events = options.includeDebug
    ? input.events
    : input.events.filter((e) => e.level !== 'debug');
  return [...events].sort((a, b) => a.seq - b.seq);
}

function durationMs(run: Run): number | undefined {
  if (!run.startedAt) return undefined;
  return (run.completedAt ?? new Date()).getTime() - run.startedAt.getTime();
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function clock(date: Date): string {
  return date.toTimeString().slice(0, 8);
}

function eventDetail(event: RunEvent): string {
  const bits: string[] = [];
  if (event.model) bits.push(`${shortModelLabel(event.model)}/${event.effort ?? '—'}`);
  if (event.durationMs !== undefined) bits.push(formatDuration(event.durationMs));
  if (event.costUsd) bits.push(formatUsd(event.costUsd));
  if (event.usage && totalTokens(event.usage) > 0) bits.push(`${formatTokens(totalTokens(event.usage))} tok`);
  return bits.join(' · ');
}

/** Per-agent totals, which no single stored row carries. */
function perAgentTotals(input: TranscriptInput) {
  return input.agents.map((agent) => {
    const own = input.events.filter((e) => e.agentId === agent.id);
    const usage = own.reduce((acc, e) => (e.usage ? addUsage(acc, e.usage) : acc), emptyUsage());
    return {
      agent,
      activations: own.filter((e) => e.type === 'agent_started').length,
      toolCalls: own.filter((e) => e.type === 'tool_call').length,
      costUsd: own.reduce((sum, e) => sum + (e.costUsd ?? 0), 0),
      tokens: totalTokens(usage),
      runtimeMs: own.reduce((sum, e) => sum + (e.durationMs ?? 0), 0),
    };
  });
}

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

function markdownTranscript(input: TranscriptInput, options: TranscriptOptions): string {
  const { run, team } = input;
  const out: string[] = [];

  out.push(`# Run ${run.id}`);
  out.push('');
  out.push(`> ${run.objective.split('\n').join('\n> ')}`);
  out.push('');

  out.push('| | |');
  out.push('| --- | --- |');
  out.push(`| Team | ${team.name} |`);
  if (run.workspace ?? team.workspace) out.push(`| Workspace | \`${run.workspace ?? team.workspace}\` |`);
  out.push(`| Status | **${run.status}** |`);
  out.push(`| Started | ${run.startedAt?.toISOString() ?? '—'} |`);
  out.push(`| Finished | ${run.completedAt?.toISOString() ?? '—'} |`);
  out.push(`| Duration | ${formatDuration(durationMs(run))} |`);
  out.push(`| Tokens | ${formatTokens(totalTokens(run.totals.usage))} |`);
  out.push(`| Cost | ${formatUsd(run.totals.costUsd)} |`);
  out.push(`| Activations | ${run.totals.agentActivations} |`);
  out.push(`| Tool calls | ${run.totals.toolCalls} |`);
  if (run.budget) out.push(`| Budget | ${describeBudget(run.budget)} |`);
  out.push('');

  out.push('## Agents');
  out.push('');
  out.push('The configuration each agent actually ran with.');
  out.push('');
  out.push('| Agent | Role | Model | Effort | Activations | Tool calls | Cost |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  const totalsByAgent = new Map(perAgentTotals(input).map((t) => [t.agent.id, t]));
  for (const snapshot of run.agentConfigSnapshot) {
    const t = totalsByAgent.get(snapshot.agentId);
    out.push(
      `| ${snapshot.handle}${snapshot.isOrchestrator ? ' *(orchestrator)*' : ''} | ${snapshot.role} | ` +
        `${shortModelLabel(snapshot.model)} | ${EFFORT_CATALOG[snapshot.effort].label} | ` +
        `${t?.activations ?? 0} | ${t?.toolCalls ?? 0} | ${formatUsd(t?.costUsd ?? 0)} |`,
    );
  }
  out.push('');

  if (input.tasks.length > 0) {
    out.push('## Tasks');
    out.push('');
    for (const task of [...input.tasks].sort((a, b) => a.order - b.order)) {
      const deps = task.dependencies
        .map((id) => input.tasks.find((t) => t.id === id)?.title ?? id)
        .join(', ');
      out.push(`### ${isTaskTerminal(task.status) ? '' : '⏳ '}${task.title}`);
      out.push('');
      out.push(
        `\`${task.status}\` · assigned to **${handleOf(input, task.assignedAgentId)}**` +
          (task.reviewerAgentId ? ` · reviewed by **${handleOf(input, task.reviewerAgentId)}**` : '') +
          (task.attempts > 1 ? ` · attempt ${task.attempts}/${task.maxAttempts}` : '') +
          (deps ? ` · after: ${deps}` : ''),
      );
      if (task.description) {
        out.push('');
        out.push(task.description);
      }
      if (task.result) {
        out.push('');
        out.push('**Result**');
        out.push('');
        out.push(task.result);
      }
      if (task.error) {
        out.push('');
        out.push(`**Error** — ${task.error}`);
      }
      out.push('');
    }
  }

  if (input.questions && input.questions.length > 0) {
    out.push('## Decisions you were asked for');
    out.push('');
    for (const q of input.questions) {
      out.push(`### ${q.header ?? 'Question'}`);
      out.push('');
      out.push(`*${handleOf(input, q.agentId)} asked:* ${q.question}`);
      if (q.options.length > 0) {
        out.push('');
        out.push(
          `Offered: ${q.options.map((o) => (o.description ? `**${o.label}** (${o.description})` : `**${o.label}**`)).join(' · ')}`,
        );
      }
      out.push('');
      out.push(
        q.answer
          ? `**Answer** (${q.answeredBy ?? 'unknown'}, ${q.status}): ${q.answer}`
          : `**Unanswered** (${q.status})`,
      );
      out.push('');
    }
  }

  if (options.includeMessages !== false && input.messages.length > 0) {
    out.push('## Messages');
    out.push('');
    for (const message of [...input.messages].sort((a, b) => a.seq - b.seq)) {
      out.push(
        `**#${message.seq} ${handleOf(input, message.from)} → ` +
          `${message.to.map((id) => handleOf(input, id)).join(', ')}** ` +
          `· ${message.type} · ${message.status} · ${clock(message.createdAt)}`,
      );
      out.push('');
      out.push(message.content.split('\n').map((l) => `> ${l}`).join('\n'));
      out.push('');
    }
  }

  out.push('## Timeline');
  out.push('');
  out.push('```');
  for (const event of visibleEvents(input, options)) {
    const detail = eventDetail(event);
    out.push(
      `${clock(event.createdAt)}  ${handleOf(input, event.agentId).padEnd(14)}${event.summary}` +
        (detail ? `  (${detail})` : ''),
    );
  }
  out.push('```');
  out.push('');

  if (run.summary) {
    out.push('## Result');
    out.push('');
    out.push(run.summary);
    out.push('');
  }
  if (run.error) {
    out.push('## Failure');
    out.push('');
    out.push(run.error);
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(`Exported from Claude Team Manager · ${new Date().toISOString()}`);

  return `${out.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * Plain text
 * ------------------------------------------------------------------ */

function textTranscript(input: TranscriptInput, options: TranscriptOptions): string {
  const { run, team } = input;
  const out: string[] = [];
  const rule = '─'.repeat(78);

  out.push(rule);
  out.push(`RUN ${run.id}  ·  ${team.name}  ·  ${run.status.toUpperCase()}`);
  out.push(rule);
  out.push(run.objective);
  out.push('');
  out.push(
    `started ${run.startedAt?.toISOString() ?? '—'}   duration ${formatDuration(durationMs(run))}   ` +
      `${formatTokens(totalTokens(run.totals.usage))} tokens   ${formatUsd(run.totals.costUsd)}   ` +
      `${run.totals.agentActivations} activations`,
  );
  out.push('');

  out.push('AGENTS');
  for (const snapshot of run.agentConfigSnapshot) {
    out.push(
      `  ${snapshot.handle.padEnd(16)}${shortModelLabel(snapshot.model).padEnd(10)}` +
        `${EFFORT_CATALOG[snapshot.effort].label.padEnd(8)}${snapshot.role}` +
        `${snapshot.isOrchestrator ? '  (orchestrator)' : ''}`,
    );
  }
  out.push('');

  if (input.tasks.length > 0) {
    out.push('TASKS');
    for (const task of [...input.tasks].sort((a, b) => a.order - b.order)) {
      out.push(
        `  [${task.status}] ${task.title} → ${handleOf(input, task.assignedAgentId)}` +
          (task.reviewerAgentId ? ` (review: ${handleOf(input, task.reviewerAgentId)})` : ''),
      );
      if (task.result) {
        for (const line of task.result.split('\n')) out.push(`      ${line}`);
      }
      if (task.error) out.push(`      ! ${task.error}`);
    }
    out.push('');
  }

  if (input.questions && input.questions.length > 0) {
    out.push('DECISIONS YOU WERE ASKED FOR');
    for (const q of input.questions) {
      out.push(`  [${q.status}] ${q.header ?? 'Question'} — asked by ${handleOf(input, q.agentId)}`);
      out.push(`      ${q.question}`);
      if (q.options.length > 0) out.push(`      offered: ${q.options.map((o) => o.label).join(' | ')}`);
      for (const line of (q.answer ?? '(unanswered)').split('\n')) out.push(`      ${line}`);
    }
    out.push('');
  }

  if (options.includeMessages !== false && input.messages.length > 0) {
    out.push('MESSAGES');
    for (const message of [...input.messages].sort((a, b) => a.seq - b.seq)) {
      out.push(
        `  #${message.seq} ${handleOf(input, message.from)} → ` +
          `${message.to.map((id) => handleOf(input, id)).join(', ')}  (${message.type})`,
      );
      for (const line of message.content.split('\n')) out.push(`      ${line}`);
    }
    out.push('');
  }

  out.push('TIMELINE');
  for (const event of visibleEvents(input, options)) {
    const detail = eventDetail(event);
    out.push(
      `  ${clock(event.createdAt)}  ${handleOf(input, event.agentId).padEnd(14)}${event.summary}` +
        (detail ? `  (${detail})` : ''),
    );
  }
  out.push('');

  if (run.summary) {
    out.push('RESULT');
    for (const line of run.summary.split('\n')) out.push(`  ${line}`);
    out.push('');
  }
  if (run.error) {
    out.push('FAILURE');
    out.push(`  ${run.error}`);
    out.push('');
  }

  out.push(rule);
  out.push(`Exported from Claude Team Manager · ${new Date().toISOString()}`);

  return `${out.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * JSON
 * ------------------------------------------------------------------ */

function jsonTranscript(input: TranscriptInput, options: TranscriptOptions): string {
  return `${JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      run: input.run,
      team: { id: input.team.id, name: input.team.name, workspace: input.team.workspace },
      agents: input.agents.map((a) => ({
        id: a.id,
        handle: a.handle,
        name: a.name,
        role: a.role,
        model: a.model,
        effort: a.effort,
      })),
      tasks: input.tasks,
      questions: input.questions ?? [],
      messages: options.includeMessages === false ? [] : input.messages,
      events: visibleEvents(input, options),
      perAgent: perAgentTotals(input).map((t) => ({
        handle: t.agent.handle,
        model: t.agent.model,
        effort: t.agent.effort,
        activations: t.activations,
        toolCalls: t.toolCalls,
        tokens: t.tokens,
        costUsd: t.costUsd,
        runtimeMs: t.runtimeMs,
      })),
    },
    null,
    2,
  )}\n`;
}
