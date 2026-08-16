import { z } from 'zod';
import { AGENT_EFFORTS } from './effort.js';
import { PERMISSION_MODES, TOOL_GROUPS } from './permissions.js';
import { AGENT_STATUSES, MESSAGE_TYPES } from './entities.js';

/**
 * Input schemas shared by every entry point (TUI prompts, HTTP handlers, YAML
 * import). Validating in one place is what keeps the HTTP controllers free of
 * business rules — see ADR-001.
 */

export const toolPermissionSchema = z.object({
  group: z.enum(TOOL_GROUPS),
  mode: z.enum(PERMISSION_MODES),
});

export const agentLimitsSchema = z.object({
  maxTurns: z.number().int().min(1).max(1000).optional(),
  timeoutMs: z.number().int().min(1000).max(6 * 60 * 60 * 1000).optional(),
  maxMessages: z.number().int().min(1).max(10_000).optional(),
});

export const budgetSchema = z.object({
  maxTokens: z.number().int().min(1).optional(),
  maxCostUsd: z.number().min(0).optional(),
  maxDurationMinutes: z.number().min(1).optional(),
  maxAgentActivations: z.number().int().min(1).optional(),
});

export const createTeamSchema = z.object({
  name: z.string().trim().min(1, 'Team name is required').max(120),
  description: z.string().max(2000).optional(),
  workspace: z.string().max(1024).optional(),
  budget: budgetSchema.optional(),
  presetId: z.string().optional(),
});

export const updateTeamSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  workspace: z.string().max(1024).nullable().optional(),
  orchestratorId: z.string().nullable().optional(),
  defaultAgentId: z.string().nullable().optional(),
  budget: budgetSchema.nullable().optional(),
});

export const createAgentSchema = z.object({
  teamId: z.string().min(1),
  name: z.string().trim().min(1, 'Agent name is required').max(120),
  role: z.string().trim().min(1, 'Agent role is required').max(120),
  handle: z.string().max(48).optional(),
  description: z.string().max(2000).optional(),
  systemPrompt: z.string().max(100_000).optional(),
  model: z.string().max(200).optional(),
  effort: z.enum(AGENT_EFFORTS).optional(),
  tools: z.array(toolPermissionSchema).optional(),
  workspace: z.string().max(1024).optional(),
  context: z.string().max(100_000).optional(),
  memory: z.object({ enabled: z.boolean().optional(), notes: z.string().max(200_000).optional() }).optional(),
  communicationRules: z.string().max(20_000).optional(),
  canMessage: z.array(z.string()).optional(),
  limits: agentLimitsSchema.optional(),
  templateId: z.string().optional(),
  order: z.number().int().min(0).optional(),
});

export const updateAgentSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  handle: z.string().trim().min(1).max(48).optional(),
  role: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  systemPrompt: z.string().max(100_000).optional(),
  model: z.string().min(1).max(200).optional(),
  effort: z.enum(AGENT_EFFORTS).optional(),
  tools: z.array(toolPermissionSchema).optional(),
  workspace: z.string().max(1024).nullable().optional(),
  context: z.string().max(100_000).optional(),
  memory: z.object({ enabled: z.boolean().optional(), notes: z.string().max(200_000).optional() }).optional(),
  communicationRules: z.string().max(20_000).optional(),
  canMessage: z.array(z.string()).optional(),
  limits: agentLimitsSchema.optional(),
  status: z.enum(AGENT_STATUSES).optional(),
  order: z.number().int().min(0).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const startRunSchema = z.object({
  teamId: z.string().min(1),
  objective: z.string().trim().min(1, 'An objective is required').max(50_000),
  budget: budgetSchema.optional(),
  workspace: z.string().max(1024).optional(),
  /** Start the run immediately instead of leaving it queued. */
  autoStart: z.boolean().optional(),
});

export const sendAgentMessageSchema = z.object({
  runId: z.string().min(1),
  from: z.string().min(1),
  to: z.array(z.string().min(1)).min(1),
  type: z.enum(MESSAGE_TYPES).optional(),
  content: z.string().trim().min(1).max(200_000),
  taskId: z.string().optional(),
  replyTo: z.string().optional(),
});

export const approvalDecisionSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(['allow_once', 'allow_always', 'deny']),
  decidedBy: z.string().optional(),
});

export const answerQuestionSchema = z.object({
  questionId: z.string().min(1),
  /** Labels chosen from the offered options. */
  selected: z.array(z.string()).optional(),
  /** Free-text answer, used alone or alongside a selection. */
  text: z.string().max(20_000).optional(),
  answeredBy: z.string().optional(),
});

export const searchSchema = z.object({
  query: z.string().trim().min(1).max(500),
  kinds: z.array(z.enum(['team', 'agent', 'run', 'task', 'message'])).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const updateSettingsSchema = z.object({
  onboardingCompleted: z.boolean().optional(),
  defaultWorkspace: z.string().max(1024).nullable().optional(),
  teamsDir: z.string().max(1024).nullable().optional(),
  defaultModel: z.string().max(200).optional(),
  defaultOrchestratorModel: z.string().max(200).optional(),
  defaultEffort: z.enum(AGENT_EFFORTS).optional(),
  provider: z.string().max(64).optional(),
  defaultBudget: budgetSchema.optional(),
  requireApprovalFor: z.array(z.string()).optional(),
  autoApproveAll: z.boolean().optional(),
  autoAnswerQuestions: z.boolean().optional(),
  questionTimeoutMs: z.number().int().min(5000).max(24 * 60 * 60 * 1000).optional(),
  maxHops: z.number().int().min(1).max(64).optional(),
  maxRecursionDepth: z.number().int().min(1).max(16).optional(),
  askTimeoutMs: z.number().int().min(1000).max(60 * 60 * 1000).optional(),
  webPort: z.number().int().min(1).max(65535).optional(),
  theme: z.enum(['auto', 'dark', 'light']).optional(),
  telemetry: z.boolean().optional(),
});

export type CreateTeamRequest = z.infer<typeof createTeamSchema>;
export type UpdateTeamRequest = z.infer<typeof updateTeamSchema>;
export type CreateAgentRequest = z.infer<typeof createAgentSchema>;
export type UpdateAgentRequest = z.infer<typeof updateAgentSchema>;
export type StartRunRequest = z.infer<typeof startRunSchema>;
export type SendAgentMessageRequest = z.infer<typeof sendAgentMessageSchema>;
export type ApprovalDecisionRequest = z.infer<typeof approvalDecisionSchema>;
export type AnswerQuestionRequest = z.infer<typeof answerQuestionSchema>;
export type SearchRequest = z.infer<typeof searchSchema>;
export type UpdateSettingsRequest = z.infer<typeof updateSettingsSchema>;
