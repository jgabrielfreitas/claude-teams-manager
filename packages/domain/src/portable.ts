import { z } from 'zod';
import { AGENT_EFFORTS, coerceEffort } from './effort.js';
import { PERMISSION_MODES, TOOL_GROUPS, defaultToolPermissions, type ToolPermission } from './permissions.js';
import { invalid } from './errors.js';
import type { Agent, Budget, Team } from './entities.js';
import type { CreateAgentInput } from './factories.js';

/**
 * Portable team format — the thing you commit to git.
 *
 * Design rules (ADR-001):
 *  - handles, not ids: a team file must survive being imported into a fresh install;
 *  - capability groups, not provider tool names;
 *  - `version` is mandatory so we can migrate the format later.
 */

export const PORTABLE_VERSION = 1;

const toolPermissionSchema = z.union([
  // Long form: { group: mode }
  z.record(z.enum(TOOL_GROUPS), z.enum(PERMISSION_MODES)),
  // Short form: a list of allowed groups
  z.array(z.enum(TOOL_GROUPS)),
]);

const limitsSchema = z
  .object({
    maxTurns: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxMessages: z.number().int().positive().optional(),
  })
  .optional();

const budgetSchema = z
  .object({
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().optional(),
    maxDurationMinutes: z.number().positive().optional(),
    maxAgentActivations: z.number().int().positive().optional(),
  })
  .optional();

const portableAgentSchema = z.object({
  name: z.string().optional(),
  role: z.string().min(1),
  description: z.string().optional(),
  model: z.string().optional(),
  effort: z.union([z.enum(AGENT_EFFORTS), z.string()]).optional(),
  system_prompt: z.string().optional(),
  systemPrompt: z.string().optional(),
  context: z.string().optional(),
  memory: z.string().optional(),
  communication_rules: z.string().optional(),
  communicationRules: z.string().optional(),
  tools: toolPermissionSchema.optional(),
  can_message: z.array(z.string()).optional(),
  canMessage: z.array(z.string()).optional(),
  workspace: z.string().optional(),
  limits: limitsSchema,
  template: z.string().optional(),
});

export const portableTeamSchema = z.object({
  version: z.number().int().positive().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  workspace: z.string().optional(),
  orchestrator: z.string().optional(),
  default_agent: z.string().optional(),
  defaultAgent: z.string().optional(),
  budget: budgetSchema,
  agents: z.record(z.string(), portableAgentSchema),
});

export type PortableTeam = z.infer<typeof portableTeamSchema>;
export type PortableAgent = z.infer<typeof portableAgentSchema>;

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

function toolsToPortable(tools: ToolPermission[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tools) out[t.group] = t.mode;
  return out;
}

export function toPortableTeam(team: Team, agents: Agent[]): PortableTeam {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const doc: PortableTeam = {
    version: PORTABLE_VERSION,
    name: team.name,
    description: team.description,
    workspace: team.workspace,
    orchestrator: team.orchestratorId ? byId.get(team.orchestratorId)?.handle : undefined,
    default_agent: team.defaultAgentId ? byId.get(team.defaultAgentId)?.handle : undefined,
    budget: team.budget,
    agents: {},
  };

  for (const agent of [...agents].sort((a, b) => a.order - b.order)) {
    doc.agents[agent.handle] = {
      name: agent.name,
      role: agent.role,
      description: agent.description,
      model: agent.model,
      effort: agent.effort,
      system_prompt: agent.systemPrompt,
      context: agent.context || undefined,
      // Memory is per-installation working state, not part of the team's shape.
      communication_rules: agent.communicationRules || undefined,
      tools: toolsToPortable(agent.tools) as PortableAgent['tools'],
      can_message: agent.canMessage,
      workspace: agent.workspace,
      limits: agent.limits,
      template: agent.templateId,
    };
  }

  return doc;
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

function portableToTools(input: PortableAgent['tools']): ToolPermission[] {
  if (!input) return defaultToolPermissions();
  if (Array.isArray(input)) {
    return TOOL_GROUPS.map((group) => ({
      group,
      mode: input.includes(group) ? ('allow' as const) : ('deny' as const),
    }));
  }
  const base = defaultToolPermissions();
  return base.map((p) => ({ group: p.group, mode: input[p.group] ?? p.mode }));
}

export interface ParsedPortableTeam {
  team: { name: string; description?: string; workspace?: string; budget?: Budget };
  agents: Array<Omit<CreateAgentInput, 'teamId'> & { handle: string }>;
  orchestratorHandle?: string;
  defaultAgentHandle?: string;
  warnings: string[];
}

/**
 * Validates and normalises a portable document into inputs the application
 * core can apply. Unknown `can_message` handles are dropped with a warning
 * rather than failing the whole import.
 */
export function parsePortableTeam(raw: unknown): ParsedPortableTeam {
  const result = portableTeamSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw invalid(
      `Invalid team file: ${issue.path.join('.') || '(root)'} — ${issue.message}`,
      { issues: result.error.issues },
    );
  }
  const doc = result.data;
  const warnings: string[] = [];

  if (doc.version && doc.version > PORTABLE_VERSION) {
    warnings.push(
      `File declares version ${doc.version}; this build understands up to ${PORTABLE_VERSION}. Unknown fields were ignored.`,
    );
  }

  const handles = Object.keys(doc.agents);
  if (handles.length === 0) throw invalid('A team file must define at least one agent');

  const known = new Set(handles);
  const agents = handles.map((handle, index) => {
    const a = doc.agents[handle];
    const canMessageRaw = a.can_message ?? a.canMessage ?? ['*'];
    const canMessage = canMessageRaw.filter((h) => {
      if (h === '*' || known.has(h)) return true;
      warnings.push(`Agent "${handle}" may message unknown agent "${h}" — dropped.`);
      return false;
    });

    return {
      handle,
      name: a.name ?? handle,
      role: a.role,
      description: a.description,
      systemPrompt: a.system_prompt ?? a.systemPrompt,
      model: a.model,
      effort: coerceEffort(a.effort),
      tools: portableToTools(a.tools),
      workspace: a.workspace,
      context: a.context,
      memory: a.memory ? { enabled: true, notes: a.memory } : undefined,
      communicationRules: a.communication_rules ?? a.communicationRules,
      canMessage,
      limits: a.limits,
      order: index,
      templateId: a.template,
    };
  });

  const orchestrator = doc.orchestrator;
  if (orchestrator && !known.has(orchestrator)) {
    warnings.push(`Orchestrator "${orchestrator}" is not one of the agents — ignored.`);
  }
  const defaultAgent = doc.default_agent ?? doc.defaultAgent;
  if (defaultAgent && !known.has(defaultAgent)) {
    warnings.push(`Default agent "${defaultAgent}" is not one of the agents — ignored.`);
  }

  return {
    team: {
      name: doc.name,
      description: doc.description,
      workspace: doc.workspace,
      budget: doc.budget,
    },
    agents,
    orchestratorHandle: orchestrator && known.has(orchestrator) ? orchestrator : undefined,
    defaultAgentHandle: defaultAgent && known.has(defaultAgent) ? defaultAgent : undefined,
    warnings,
  };
}
