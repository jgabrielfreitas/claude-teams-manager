import type { FakeBehavior, FakeContext, FakeStep } from './fake-provider.js';
import type { AgentRunInput } from './types.js';

/**
 * Scripted agent output for the `fake` provider.
 *
 * This is a *provider fixture*, not application behaviour: it stands in for the
 * text a real model would produce, so the whole product — task DAG, delegation,
 * agent-to-agent messaging, review, timeline, cost accounting — can be
 * demonstrated and developed against without spending a token. Every rule about
 * what happens with that output still lives in the runtime.
 *
 * It reads the team's shape out of the prompt it is given rather than hardcoding
 * handles, so it works for any preset or hand-built team.
 *
 * It lives here, next to `FakeAgentProvider`, so the TUI and the Web behave
 * identically under `--provider fake`. Constructing `FakeAgentProvider`
 * directly still gives the minimal built-in behaviour, which is what the test
 * suite wants.
 */

const ANSWER_MARKER = 'is blocked waiting on your answer';
const PLANNING_MARKER = 'Plan and execute this objective';
const REVIEW_MARKER = 'VERDICT:';

/** Handles this agent may address, as advertised by its messaging tool. */
function reachableHandles(input: AgentRunInput): string[] {
  const description = input.customTools.find((t) => t.name === 'send_message')?.description ?? '';
  const match = /You may message: ([^.]*)\./.exec(description);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h && h !== 'nobody' && h !== 'user' && h !== input.agentHandle);
}

/** Team roster, parsed from the "- handle — role" block of the system prompt. */
function rosterHandles(input: AgentRunInput): string[] {
  return [...input.systemPrompt.matchAll(/^- ([a-zA-Z0-9._-]+) — /gm)]
    .map((m) => m[1])
    .filter((h) => h !== input.agentHandle);
}

function objectiveOf(prompt: string): string {
  const match = /Plan and execute this objective:\s*\n+([^\n]+)/.exec(prompt);
  return match?.[1]?.trim() ?? 'the objective';
}

export function demoBehavior(ctx: FakeContext): FakeStep[] {
  const { input } = ctx;
  const isOrchestrator = input.customTools.some((t) => t.name === 'create_tasks');
  const canMessage = reachableHandles(input);

  if (input.prompt.includes(ANSWER_MARKER)) {
    return [
      {
        kind: 'text',
        text: 'Go with the simplest option that we can change later, and write down why.',
      },
    ];
  }

  if (input.prompt.includes(REVIEW_MARKER)) {
    return [
      { kind: 'thinking', text: 'Reading the result against the acceptance criteria.' },
      {
        kind: 'text',
        text: 'The result matches the task description and the approach is reasonable.\nVERDICT: APPROVED',
      },
    ];
  }

  if (isOrchestrator) {
    if (!input.prompt.includes(PLANNING_MARKER)) {
      return [
        { kind: 'tool', tool: 'list_tasks', args: {} },
        {
          kind: 'tool',
          tool: 'finish',
          args: {
            summary:
              'The team delivered the objective: the work was split across the roster, executed and reviewed.',
          },
        },
        { kind: 'text', text: 'Synthesised the team output.' },
      ];
    }

    const team = rosterHandles(input);
    const objective = objectiveOf(input.prompt);

    if (team.length === 0) {
      return [
        { kind: 'thinking', text: `Working on: ${objective}` },
        { kind: 'tool', tool: 'finish', args: { summary: `Handled "${objective}" single-handedly.` } },
      ];
    }

    const [first, second = first, third] = team;
    const tasks: Record<string, unknown>[] = [
      {
        key: 'design',
        title: `Design the approach for: ${objective}`,
        description: 'Write down the shape of the solution and the trade-off you rejected.',
        assignee: first,
      },
      {
        key: 'build',
        title: `Implement the plan for: ${objective}`,
        description: 'Follow the design and report exactly what you changed.',
        assignee: second,
        dependsOn: ['design'],
        ...(third ? { reviewer: third } : {}),
      },
    ];

    return [
      { kind: 'thinking', text: 'Breaking the objective into independent pieces.' },
      { kind: 'tool', tool: 'create_tasks', args: { tasks } },
      { kind: 'text', text: 'Plan created and delegated to the team.' },
    ];
  }

  const steps: FakeStep[] = [
    { kind: 'thinking', text: 'Reading the task and the workspace before acting.' },
  ];

  if (canMessage.length > 0) {
    steps.push({
      kind: 'tool',
      tool: 'send_message',
      args: {
        to: [canMessage[0]],
        type: 'result',
        content: `${input.agentHandle} here — my part is done, the result is on the task.`,
      },
    });
  }

  steps.push({
    kind: 'text',
    text: `Completed by ${input.agentHandle}. (Demo provider: no real model was called.)`,
  });

  return steps;
}

export const DEMO_BEHAVIOR: FakeBehavior = demoBehavior;
