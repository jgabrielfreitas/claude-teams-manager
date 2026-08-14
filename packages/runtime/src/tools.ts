import { z } from 'zod';
import { MESSAGE_TYPES, type Agent } from '@claude-team/domain';
import type { ProviderToolSpec } from '@claude-team/provider';

/**
 * The in-process tools that make a team a team.
 *
 * These are real host functions exposed to the model through the provider's
 * in-process MCP support — not prompt conventions the model is asked to
 * follow. An agent calling `create_tasks` really does insert rows the
 * scheduler then dispatches (ADR-002).
 */

export interface TaskSpecInput {
  key: string;
  title: string;
  description?: string;
  assignee: string;
  dependsOn?: string[];
  reviewer?: string;
}

/** Implemented by the run engine; the tools are a thin schema layer over it. */
export interface ToolHost {
  sendMessage(sender: Agent, args: { to: string[]; type?: string; content: string }): Promise<string>;
  askAgent(sender: Agent, args: { to: string; question: string }): Promise<string>;
  checkInbox(agent: Agent): Promise<string>;
  remember(agent: Agent, note: string): Promise<string>;

  createTasks(sender: Agent, specs: TaskSpecInput[]): Promise<string>;
  listTasks(): Promise<string>;
  updateTask(
    sender: Agent,
    args: { taskId: string; status?: string; assignee?: string; note?: string },
  ): Promise<string>;
  finish(sender: Agent, summary: string): Promise<string>;
}

export interface ToolBuildOptions {
  agent: Agent;
  host: ToolHost;
  /** Orchestration tools are only handed to the run's orchestrator. */
  isOrchestrator: boolean;
  /** Handles this agent may address, for the tool descriptions. */
  reachableHandles: string[];
  /** Disable messaging entirely when the capability is denied. */
  messagingEnabled: boolean;
}

export function buildToolSpecs(options: ToolBuildOptions): ProviderToolSpec[] {
  const { agent, host, isOrchestrator, reachableHandles, messagingEnabled } = options;
  const specs: ProviderToolSpec[] = [];
  const roster = reachableHandles.length ? reachableHandles.join(', ') : 'nobody';

  if (messagingEnabled) {
    specs.push({
      name: 'send_message',
      description:
        `Send a message to one or more teammates without waiting for a reply. ` +
        `You may message: ${roster}. Use "user" to write to the human.`,
      inputSchema: {
        to: z
          .array(z.string())
          .min(1)
          .describe('Handles of the recipients, or "user" for the human.'),
        type: z
          .enum(MESSAGE_TYPES)
          .optional()
          .describe('The kind of message. Defaults to "message".'),
        content: z.string().min(1).describe('The message body.'),
      },
      handler: async (args) =>
        text(
          await host.sendMessage(agent, {
            to: args.to as string[],
            type: args.type as string | undefined,
            content: String(args.content),
          }),
        ),
    });

    specs.push({
      name: 'ask_agent',
      description:
        `Ask one teammate a question and WAIT for their answer. This blocks you until they reply, ` +
        `so use it only when you cannot continue without the answer. You may ask: ${roster}.`,
      inputSchema: {
        to: z.string().describe('Handle of the teammate to ask.'),
        question: z.string().min(1).describe('The question. Be specific and self-contained.'),
      },
      handler: async (args) =>
        text(await host.askAgent(agent, { to: String(args.to), question: String(args.question) })),
    });

    specs.push({
      name: 'check_inbox',
      description: 'Read the messages waiting for you and mark them as read.',
      inputSchema: {},
      handler: async () => text(await host.checkInbox(agent)),
    });
  }

  if (agent.memory.enabled) {
    specs.push({
      name: 'remember',
      description:
        'Save a short, durable note to your own memory. It will be available to you in future runs. ' +
        'Use it for facts about this codebase or team that you would otherwise have to rediscover.',
      inputSchema: {
        note: z.string().min(1).max(2000).describe('The note to remember. One or two sentences.'),
      },
      handler: async (args) => text(await host.remember(agent, String(args.note))),
    });
  }

  if (isOrchestrator) {
    specs.push({
      name: 'create_tasks',
      description:
        'Create one or more tasks and assign them to teammates. Tasks with no unmet dependency run ' +
        'in parallel, so express real ordering only. Use short `key` values to reference other tasks ' +
        'in this same call through `dependsOn`.',
      inputSchema: {
        tasks: z
          .array(
            z.object({
              key: z.string().describe('Short identifier for this task within this call, e.g. "api".'),
              title: z.string().min(1).describe('Short imperative title.'),
              description: z
                .string()
                .optional()
                .describe('Everything the assignee needs in order to do this without asking you.'),
              assignee: z.string().describe('Handle of the agent who will do it.'),
              dependsOn: z
                .array(z.string())
                .optional()
                .describe('Keys from this call, or ids of existing tasks, that must complete first.'),
              reviewer: z
                .string()
                .optional()
                .describe('Handle of an agent that must review the result before it counts as done.'),
            }),
          )
          .min(1),
      },
      handler: async (args) => text(await host.createTasks(agent, args.tasks as TaskSpecInput[])),
    });

    specs.push({
      name: 'list_tasks',
      description: 'Show the current task board with ids, statuses, assignees and results.',
      inputSchema: {},
      handler: async () => text(await host.listTasks()),
    });

    specs.push({
      name: 'update_task',
      description:
        'Change a task: reassign it, cancel it, send it back for rework, or attach a note. ' +
        'Use the task id from `list_tasks`.',
      inputSchema: {
        taskId: z.string().describe('Id of the task to update.'),
        status: z
          .enum(['ready', 'blocked', 'cancelled', 'completed', 'failed'])
          .optional()
          .describe('New status.'),
        assignee: z.string().optional().describe('Handle of the new assignee.'),
        note: z.string().optional().describe('A note appended to the task description.'),
      },
      handler: async (args) =>
        text(
          await host.updateTask(agent, {
            taskId: String(args.taskId),
            status: args.status as string | undefined,
            assignee: args.assignee as string | undefined,
            note: args.note as string | undefined,
          }),
        ),
    });

    specs.push({
      name: 'finish',
      description:
        'End the run and hand the result to the human. Call this once the objective is met, or when ' +
        'you have concluded it cannot be met — in which case say so plainly in the summary.',
      inputSchema: {
        summary: z
          .string()
          .min(1)
          .describe('The final answer for the human: what was done, what was verified, what is left.'),
      },
      handler: async (args) => text(await host.finish(agent, String(args.summary))),
    });
  }

  return specs;
}

function text(value: string): { text: string } {
  return { text: value };
}
