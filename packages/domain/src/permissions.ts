/**
 * Capability model.
 *
 * Agents are configured in terms of *capability groups* ("filesystem", "git",
 * "terminal"), not in terms of a specific provider's tool names. The provider
 * adapter expands a group into concrete tool identifiers (see ADR-004), which
 * keeps `Agent` portable across providers and keeps exported team YAML stable.
 */

export const TOOL_GROUPS = [
  'filesystem_read',
  'filesystem_write',
  'terminal',
  'git',
  'network',
  'browser',
  'mcp',
  'agent_messaging',
] as const;

export type ToolGroupId = (typeof TOOL_GROUPS)[number];

/** What happens when an agent tries to use a capability. */
export const PERMISSION_MODES = ['allow', 'ask', 'deny'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface ToolPermission {
  group: ToolGroupId;
  mode: PermissionMode;
}

export interface ToolGroupDescriptor {
  id: ToolGroupId;
  label: string;
  description: string;
  /** True when misuse can destroy user data — the UI highlights these. */
  sensitive: boolean;
  defaultMode: PermissionMode;
}

export const TOOL_GROUP_CATALOG: Record<ToolGroupId, ToolGroupDescriptor> = {
  filesystem_read: {
    id: 'filesystem_read',
    label: 'Filesystem (read)',
    description: 'Read, list and search files inside the workspace.',
    sensitive: false,
    defaultMode: 'allow',
  },
  filesystem_write: {
    id: 'filesystem_write',
    label: 'Filesystem (write)',
    description: 'Create, edit and delete files inside the workspace.',
    sensitive: true,
    defaultMode: 'ask',
  },
  terminal: {
    id: 'terminal',
    label: 'Terminal',
    description: 'Run shell commands.',
    sensitive: true,
    defaultMode: 'ask',
  },
  git: {
    id: 'git',
    label: 'Git',
    description: 'Inspect and manipulate the git repository.',
    sensitive: true,
    defaultMode: 'ask',
  },
  network: {
    id: 'network',
    label: 'Network',
    description: 'Fetch URLs and search the web.',
    sensitive: false,
    defaultMode: 'ask',
  },
  browser: {
    id: 'browser',
    label: 'Browser',
    description: 'Drive a browser through an MCP browser server, when available.',
    sensitive: false,
    defaultMode: 'deny',
  },
  mcp: {
    id: 'mcp',
    label: 'MCP servers',
    description: 'Use tools exposed by configured MCP servers.',
    sensitive: true,
    defaultMode: 'ask',
  },
  agent_messaging: {
    id: 'agent_messaging',
    label: 'Agent messaging',
    description: 'Send messages, questions and hand-offs to teammates.',
    sensitive: false,
    defaultMode: 'allow',
  },
};

/** Sensible default capability set for a newly created agent. */
export function defaultToolPermissions(): ToolPermission[] {
  return TOOL_GROUPS.map((group) => ({ group, mode: TOOL_GROUP_CATALOG[group].defaultMode }));
}

/** Build a permission list from a simple "these groups are allowed" shorthand. */
export function permissionsFromGroups(
  allowed: ToolGroupId[],
  opts: { askInsteadOfAllow?: ToolGroupId[] } = {},
): ToolPermission[] {
  const ask = new Set(opts.askInsteadOfAllow ?? []);
  const allow = new Set(allowed);
  return TOOL_GROUPS.map((group) => ({
    group,
    mode: allow.has(group) ? (ask.has(group) ? 'ask' : 'allow') : 'deny',
  }));
}

export function permissionMode(permissions: ToolPermission[], group: ToolGroupId): PermissionMode {
  return permissions.find((p) => p.group === group)?.mode ?? TOOL_GROUP_CATALOG[group].defaultMode;
}

export function allowedGroups(permissions: ToolPermission[]): ToolGroupId[] {
  return permissions.filter((p) => p.mode !== 'deny').map((p) => p.group);
}

/**
 * Human-in-the-loop approval categories. These are what a human is asked
 * about; they are derived from the capability being exercised plus heuristics
 * (e.g. a shell command containing `rm -rf` is a destructive operation).
 */
export const APPROVAL_CATEGORIES = [
  'filesystem_write',
  'shell',
  'git',
  'network',
  'mcp',
  'external_api',
  'destructive',
] as const;

export type ApprovalCategory = (typeof APPROVAL_CATEGORIES)[number];

export const APPROVAL_CATEGORY_LABELS: Record<ApprovalCategory, string> = {
  filesystem_write: 'Filesystem write',
  shell: 'Shell commands',
  git: 'Git',
  network: 'Network',
  mcp: 'MCP',
  external_api: 'External APIs',
  destructive: 'Destructive operations',
};

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i,
  /\brm\s+-rf?\b/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)/i,
  /\bdrop\s+(table|database)\b/i,
  /\btruncate\s+table\b/i,
  /\bmkfs\b|\bdd\s+if=/i,
  /:\s*>\s*\/dev\/sd/i,
  /\bshutdown\b|\breboot\b/i,
  /\bchmod\s+-R\s+777\b/i,
  /\bnpm\s+publish\b|\bpnpm\s+publish\b/i,
];

export function looksDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(command));
}

/** Map a capability group to the approval category a human sees. */
export function categoryForGroup(group: ToolGroupId): ApprovalCategory {
  switch (group) {
    case 'filesystem_write':
      return 'filesystem_write';
    case 'terminal':
      return 'shell';
    case 'git':
      return 'git';
    case 'network':
    case 'browser':
      return 'network';
    case 'mcp':
      return 'mcp';
    default:
      return 'external_api';
  }
}
