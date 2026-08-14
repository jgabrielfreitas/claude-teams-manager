import {
  EFFORT_CATALOG,
  canMessage,
  isTaskTerminal,
  shortModelLabel,
  type Agent,
  type AgentMessage,
  type Run,
  type Task,
  type Team,
} from '@claude-team/domain';

/**
 * System-prompt assembly.
 *
 * The agent's own `systemPrompt` always comes first and is never rewritten —
 * it is the user's configuration. Everything after it is machine-generated
 * situational context: who the agent is on this team, what the run is about,
 * who it may talk to, and how to use the team tools.
 */

export interface PromptContext {
  team: Team;
  run: Run;
  agent: Agent;
  agents: Agent[];
  orchestrator: Agent;
  workspace?: string;
  gitSummary?: string;
  isOrchestrator: boolean;
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const { agent, agents, team, run } = ctx;
  const sections: string[] = [];

  sections.push(agent.systemPrompt.trim());

  sections.push(
    section('Who you are', [
      `You are "${agent.handle}" — ${agent.name}, ${agent.role} — on the team "${team.name}".`,
      ctx.isOrchestrator
        ? 'You are the ORCHESTRATOR of this run. You own the plan and the final answer.'
        : `The orchestrator of this run is "${ctx.orchestrator.handle}".`,
      `You are running on model ${shortModelLabel(agent.model)} at ${EFFORT_CATALOG[agent.effort].label.toLowerCase()} reasoning effort.`,
    ]),
  );

  sections.push(section('The objective of this run', [run.objective]));

  const roster = agents
    .filter((a) => a.id !== agent.id)
    .sort((a, b) => a.order - b.order)
    .map((a) => {
      const reachable = canMessage(agent, a.handle);
      return `- ${a.handle} — ${a.role} (${shortModelLabel(a.model)}/${a.effort})${
        reachable ? '' : ' — you may NOT message this agent'
      }`;
    });
  sections.push(
    section(
      'Your teammates',
      roster.length ? roster : ['You are the only agent on this team.'],
    ),
  );

  if (ctx.workspace) {
    const lines = [`All file work happens in: ${ctx.workspace}`];
    if (ctx.gitSummary) lines.push(ctx.gitSummary);
    sections.push(section('Workspace', lines));
  }

  if (agent.context.trim()) {
    sections.push(section('Additional context', [agent.context.trim()]));
  }

  if (agent.memory.enabled && agent.memory.notes.trim()) {
    sections.push(
      section('Your memory from previous runs', [
        agent.memory.notes.trim(),
        '',
        'Use `remember` to add a durable note. Keep it short and factual.',
      ]),
    );
  }

  const commRules = [
    'Use `send_message` to tell a teammate something without waiting for them.',
    'Use `ask_agent` when you genuinely cannot continue without their answer — it blocks you until they reply.',
    'Use `check_inbox` to read messages that arrived for you.',
    'Do not ask a teammate for something you can determine yourself.',
  ];
  if (agent.communicationRules.trim()) commRules.unshift(agent.communicationRules.trim());
  sections.push(section('Communicating with your team', commRules));

  if (ctx.isOrchestrator) {
    sections.push(
      section('How to orchestrate', [
        'Your job is to turn the objective into tasks, delegate them, keep the work moving, and produce the final answer.',
        '',
        '1. Read the objective and the workspace before planning.',
        '2. Call `create_tasks` once with the full initial plan. Give each task a short `key`,',
        '   assign it to a teammate by handle, and express ordering with `dependsOn` keys.',
        '   Independent tasks run in parallel, so do not serialise work that need not be.',
        '3. Only assign work to agents whose role fits it. Do not do the implementation yourself.',
        '4. Assigned tasks are dispatched AUTOMATICALLY as soon as this activation ends, and the',
        '   assignee is activated with the full task description. Do NOT use `ask_agent` to hand',
        '   someone a task — that duplicates the work and costs twice. `ask_agent` is only for a',
        '   question you personally need answered before you can plan.',
        '5. After each round you are shown the task board with every result. React:',
        '   add tasks, reassign, ask for a review, or answer a question.',
        '6. When the objective is met, call `finish` with the synthesised result for the human.',
        '',
        'Rules: never call `finish` while tasks are still incomplete unless you explain why.',
        'If a task failed twice, either reassign it, replace it, or finish and report the blocker honestly.',
      ]),
    );
  } else {
    sections.push(
      section('How to work', [
        'You are given one task at a time. Do it completely, then report what you did.',
        'Your final message is recorded as the task result — make it a real report:',
        'what you changed, what you verified, and anything you deliberately left out.',
        'If you are blocked, say so explicitly instead of inventing a result.',
      ]),
    );
  }

  const limits: string[] = [];
  if (agent.limits.maxTurns) limits.push(`At most ${agent.limits.maxTurns} turns per activation.`);
  if (agent.limits.timeoutMs)
    limits.push(`Each activation times out after ${Math.round(agent.limits.timeoutMs / 60000)} minutes.`);
  if (limits.length) sections.push(section('Your limits', limits));

  return sections.filter(Boolean).join('\n\n');
}

/* ------------------------------------------------------------------ *
 * Activation prompts
 * ------------------------------------------------------------------ */

export function buildOrchestratorPrompt(opts: {
  round: number;
  objective: string;
  tasks: Task[];
  agents: Agent[];
  newMessages: AgentMessage[];
  notes: string[];
}): string {
  const parts: string[] = [];

  if (opts.round === 1) {
    parts.push(
      `Plan and execute this objective:\n\n${opts.objective}\n\n` +
        'Start by understanding the situation, then call `create_tasks` with your plan. ' +
        'If the objective is small enough to do yourself, do it and call `finish`.',
    );
  } else {
    parts.push(`Round ${opts.round}. Here is the current state of the run.`);
  }

  if (opts.tasks.length > 0) {
    parts.push(`## Task board\n${renderTaskBoard(opts.tasks, opts.agents)}`);
  }

  if (opts.newMessages.length > 0) {
    parts.push(
      `## New messages for you\n${opts.newMessages
        .map((m) => `#${m.seq} from ${handleOf(opts.agents, m.from)} (${m.type}):\n${indent(m.content)}`)
        .join('\n\n')}`,
    );
  }

  if (opts.notes.length > 0) {
    parts.push(`## Notes from the runtime\n${opts.notes.map((n) => `- ${n}`).join('\n')}`);
  }

  if (opts.round > 1) {
    const outstanding = opts.tasks.filter((t) => !isTaskTerminal(t.status));
    parts.push(
      outstanding.length === 0
        ? 'Every task has settled. Synthesise the result and call `finish`.'
        : 'Decide what happens next: add tasks, reassign, answer questions, or call `finish` if the objective is already met.',
    );
  }

  return parts.join('\n\n');
}

export function buildTaskPrompt(opts: {
  task: Task;
  objective: string;
  dependencies: Task[];
  inbox: AgentMessage[];
  agents: Agent[];
  attempt: number;
}): string {
  const parts: string[] = [];

  parts.push(`## Run objective\n${opts.objective}`);
  parts.push(
    `## Your task${opts.attempt > 1 ? ` (attempt ${opts.attempt})` : ''}\n**${opts.task.title}**\n\n${
      opts.task.description || '(no further description)'
    }`,
  );

  const done = opts.dependencies.filter((d) => d.result);
  if (done.length > 0) {
    parts.push(
      `## Results of the work this depends on\n${done
        .map((d) => `### ${d.title}\n${indent(truncate(d.result ?? '', 2000))}`)
        .join('\n\n')}`,
    );
  }

  if (opts.task.error && opts.attempt > 1) {
    parts.push(`## Why the previous attempt failed\n${opts.task.error}`);
  }

  if (opts.inbox.length > 0) {
    parts.push(
      `## Messages waiting for you\n${opts.inbox
        .map((m) => `#${m.seq} from ${handleOf(opts.agents, m.from)} (${m.type}):\n${indent(m.content)}`)
        .join('\n\n')}`,
    );
  }

  parts.push(
    'Do the task now. When you are finished, your final message is recorded as the task result.',
  );

  return parts.join('\n\n');
}

export function buildReviewPrompt(opts: {
  task: Task;
  objective: string;
  authorHandle: string;
}): string {
  return [
    `## Run objective\n${opts.objective}`,
    `## Review this completed task\n**${opts.task.title}**\n\n${opts.task.description}`,
    `## What ${opts.authorHandle} reported\n${indent(truncate(opts.task.result ?? '', 4000))}`,
    'Verify the work against the task. Read the actual code or artefacts — do not take the report at face value.',
    'End your message with exactly one line: `VERDICT: APPROVED` or `VERDICT: CHANGES_REQUESTED`, ' +
      'followed by the specific changes needed if you rejected it.',
  ].join('\n\n');
}

export function buildAnswerPrompt(opts: {
  question: string;
  fromHandle: string;
  objective: string;
}): string {
  return [
    `## Run objective\n${opts.objective}`,
    `## ${opts.fromHandle} is blocked waiting on your answer\n${opts.question}`,
    'Answer directly and concisely. They cannot continue until you reply, so decide rather than deferring.',
  ].join('\n\n');
}

/* ------------------------------------------------------------------ *
 * Rendering helpers
 * ------------------------------------------------------------------ */

export function renderTaskBoard(tasks: Task[], agents: Agent[]): string {
  if (tasks.length === 0) return '(no tasks yet)';
  return tasks
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((t) => {
      const assignee = t.assignedAgentId
        ? (agents.find((a) => a.id === t.assignedAgentId)?.handle ?? '?')
        : 'unassigned';
      const deps = t.dependencies.length
        ? ` deps=[${t.dependencies
            .map((d) => tasks.find((x) => x.id === d)?.title ?? d)
            .join(', ')}]`
        : '';
      const result = t.result ? `\n    result: ${truncate(firstLine(t.result), 200)}` : '';
      const error = t.error ? `\n    error: ${truncate(firstLine(t.error), 200)}` : '';
      return `- [${t.status}] ${t.id} "${t.title}" → ${assignee}${deps}${result}${error}`;
    })
    .join('\n');
}

function section(title: string, lines: string[]): string {
  return `## ${title}\n${lines.join('\n')}`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function handleOf(agents: Agent[], id: string): string {
  if (id === 'user') return 'user';
  return agents.find((a) => a.id === id)?.handle ?? id;
}
