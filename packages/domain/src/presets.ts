import type { AgentEffort } from './effort.js';

/**
 * Team presets: a named set of agent templates plus the wiring between them
 * (who orchestrates, who may talk to whom, and each member's model/effort).
 *
 * A preset is expanded into real, fully editable agents at creation time —
 * nothing about a preset is referenced afterwards.
 */
export interface PresetMember {
  /** Agent template id. */
  templateId: string;
  /** Handle inside the team; overrides the template default. */
  handle?: string;
  /** Overrides the template's suggested model. */
  model?: string;
  /** Overrides the template's suggested effort. */
  effort?: AgentEffort;
  /** Handles this member may message. `['*']` means everyone. */
  canMessage?: string[];
  orchestrator?: boolean;
}

export interface TeamPreset {
  id: string;
  name: string;
  description: string;
  members: PresetMember[];
}

export const TEAM_PRESETS: TeamPreset[] = [
  {
    id: 'software-engineering',
    name: 'Software Engineering',
    description:
      'Architect orchestrates. Backend and frontend implement in parallel, QA tests, reviewer gates the result.',
    members: [
      {
        templateId: 'software-architect',
        handle: 'architect',
        orchestrator: true,
        effort: 'high',
        canMessage: ['*'],
      },
      {
        templateId: 'backend-engineer',
        handle: 'backend',
        effort: 'medium',
        canMessage: ['architect', 'frontend', 'qa', 'reviewer'],
      },
      {
        templateId: 'frontend-engineer',
        handle: 'frontend',
        effort: 'medium',
        canMessage: ['architect', 'backend', 'qa', 'reviewer'],
      },
      {
        templateId: 'qa-engineer',
        handle: 'qa',
        effort: 'high',
        canMessage: ['architect', 'backend', 'frontend', 'reviewer'],
      },
      {
        templateId: 'code-reviewer',
        handle: 'reviewer',
        effort: 'high',
        canMessage: ['architect', 'backend', 'frontend', 'qa'],
      },
    ],
  },
  {
    id: 'research',
    name: 'Research',
    description:
      'Research lead frames the question, researchers and an analyst gather in parallel, a fact checker verifies, a writer synthesises.',
    members: [
      { templateId: 'research-lead', handle: 'lead', orchestrator: true, effort: 'high', canMessage: ['*'] },
      {
        templateId: 'researcher',
        handle: 'web-researcher',
        effort: 'medium',
        canMessage: ['lead', 'analyst', 'fact-checker', 'writer'],
      },
      {
        templateId: 'data-analyst',
        handle: 'analyst',
        effort: 'high',
        canMessage: ['lead', 'web-researcher', 'fact-checker', 'writer'],
      },
      {
        templateId: 'fact-checker',
        handle: 'fact-checker',
        effort: 'high',
        canMessage: ['lead', 'web-researcher', 'analyst', 'writer'],
      },
      {
        templateId: 'writer',
        handle: 'writer',
        effort: 'medium',
        canMessage: ['lead', 'web-researcher', 'analyst', 'fact-checker'],
      },
    ],
  },
  {
    id: 'product',
    name: 'Product',
    description:
      'A product manager orchestrates discovery, a researcher and a UX designer shape the solution, an engineer builds it, a reviewer checks it.',
    members: [
      { templateId: 'product-manager', handle: 'pm', orchestrator: true, effort: 'high', canMessage: ['*'] },
      {
        templateId: 'researcher',
        handle: 'researcher',
        effort: 'medium',
        canMessage: ['pm', 'ux', 'engineer', 'reviewer'],
      },
      { templateId: 'ux-designer', handle: 'ux', effort: 'medium', canMessage: ['pm', 'researcher', 'engineer'] },
      {
        templateId: 'backend-engineer',
        handle: 'engineer',
        effort: 'medium',
        canMessage: ['pm', 'ux', 'reviewer'],
      },
      { templateId: 'code-reviewer', handle: 'reviewer', effort: 'high', canMessage: ['pm', 'engineer'] },
    ],
  },
  {
    id: 'solo',
    name: 'Solo Agent',
    description: 'A single generalist agent. The simplest possible team — good for trying things out.',
    members: [{ templateId: 'generalist', handle: 'assistant', orchestrator: true, effort: 'medium' }],
  },
  {
    id: 'review-board',
    name: 'Review Board',
    description:
      'A read-only team that audits an existing codebase from three angles and reports back. Makes no changes.',
    members: [
      { templateId: 'tech-lead', handle: 'lead', orchestrator: true, effort: 'high', canMessage: ['*'] },
      { templateId: 'code-reviewer', handle: 'reviewer', effort: 'high', canMessage: ['lead'] },
      { templateId: 'security-reviewer', handle: 'security', effort: 'high', canMessage: ['lead'] },
      { templateId: 'qa-engineer', handle: 'qa', effort: 'high', canMessage: ['lead'] },
    ],
  },
];

export function findPreset(id: string): TeamPreset | undefined {
  return TEAM_PRESETS.find((p) => p.id === id);
}
