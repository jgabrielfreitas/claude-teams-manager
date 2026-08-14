import {
  TOOL_GROUPS,
  categoryForGroup,
  looksDestructive,
  permissionMode,
  type ToolGroupId,
  type ToolPermission,
} from '@claude-team/domain';

/**
 * Translation between the domain's capability groups and Claude's concrete
 * tool names. This mapping is the *only* place that knows what Claude's tools
 * are called, which is what keeps `Agent` portable across providers.
 */

const GROUP_TOOLS: Record<ToolGroupId, string[]> = {
  filesystem_read: ['Read', 'Glob', 'Grep', 'NotebookRead'],
  filesystem_write: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
  // Git is exercised through the shell, so it grants Bash too. The permission
  // callback then separates `git ...` from other commands by inspecting input.
  terminal: ['Bash', 'BashOutput', 'KillShell', 'KillBash'],
  git: ['Bash'],
  network: ['WebFetch', 'WebSearch'],
  browser: [],
  mcp: [],
  agent_messaging: [],
};

/** Tools that are always available regardless of configuration. */
const ALWAYS_ALLOWED = ['TodoWrite'];

export function toolsForGroup(group: ToolGroupId): string[] {
  return GROUP_TOOLS[group] ?? [];
}

/**
 * Reverse lookup: which capability group does this tool belong to?
 * MCP tools (`mcp__server__tool`) map to `mcp`, except our own in-process
 * messaging server which maps to `agent_messaging`.
 */
export function groupForTool(toolName: string, messagingServerName: string): ToolGroupId | undefined {
  if (toolName.startsWith(`mcp__${messagingServerName}__`)) return 'agent_messaging';
  if (toolName.startsWith('mcp__')) {
    return /browser|playwright|puppeteer|chrome/i.test(toolName) ? 'browser' : 'mcp';
  }
  for (const group of TOOL_GROUPS) {
    if (GROUP_TOOLS[group].includes(toolName)) return group;
  }
  return undefined;
}

export interface ResolvedToolGrants {
  /** Auto-approved: the provider will not raise a permission request. */
  allowedTools: string[];
  /** Removed from the agent's context entirely. */
  disallowedTools: string[];
  /** Tools that exist but must be approved before each use. */
  askTools: string[];
}

/**
 * Expands capability grants into the three lists the SDK understands.
 *
 * Precedence rules, in order:
 *  - a tool is denied when every group that grants it denies it;
 *  - a tool asks when any granting group asks and none allows it;
 *  - a tool is allowed when any granting group allows it.
 *
 * `Bash` is the interesting case: `git: allow` + `terminal: deny` yields
 * `Bash` in `askTools`, and the permission callback then allows `git ...`
 * while denying everything else.
 */
export function resolveToolGrants(
  permissions: ToolPermission[],
  customToolNames: string[],
): ResolvedToolGrants {
  const best = new Map<string, 'allow' | 'ask' | 'deny'>();

  const rank = { deny: 0, ask: 1, allow: 2 } as const;
  for (const group of TOOL_GROUPS) {
    const mode = permissionMode(permissions, group);
    for (const tool of GROUP_TOOLS[group]) {
      const current = best.get(tool);
      if (!current || rank[mode] > rank[current]) best.set(tool, mode);
    }
  }

  // Bash is special: `terminal: deny` alone must not silently allow shell
  // access through a `git: allow` grant. Downgrade to `ask` so the callback
  // can inspect the actual command.
  const terminal = permissionMode(permissions, 'terminal');
  const git = permissionMode(permissions, 'git');
  if (terminal === 'deny' && git !== 'deny') best.set('Bash', 'ask');
  if (terminal === 'deny' && git === 'deny') best.set('Bash', 'deny');

  const allowedTools: string[] = [...ALWAYS_ALLOWED, ...customToolNames];
  const disallowedTools: string[] = [];
  const askTools: string[] = [];

  for (const [tool, mode] of best) {
    if (mode === 'allow') allowedTools.push(tool);
    else if (mode === 'ask') askTools.push(tool);
    else disallowedTools.push(tool);
  }

  return {
    allowedTools: [...new Set(allowedTools)],
    disallowedTools: [...new Set(disallowedTools)],
    askTools: [...new Set(askTools)],
  };
}

/**
 * A one-line description of what a tool call will actually do, used verbatim
 * in the approval prompt shown to the human.
 */
export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  const str = (key: string): string | undefined => {
    const v = input[key];
    return typeof v === 'string' ? v : undefined;
  };

  switch (toolName) {
    case 'Bash':
      return `Run shell command: ${truncate(str('command') ?? '', 300)}`;
    case 'Write':
      return `Write file: ${str('file_path') ?? '?'}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit file: ${str('file_path') ?? '?'}`;
    case 'NotebookEdit':
      return `Edit notebook: ${str('notebook_path') ?? '?'}`;
    case 'Read':
      return `Read file: ${str('file_path') ?? '?'}`;
    case 'WebFetch':
      return `Fetch URL: ${str('url') ?? '?'}`;
    case 'WebSearch':
      return `Web search: ${truncate(str('query') ?? '', 120)}`;
    default:
      return `${toolName}(${truncate(safeJson(input), 200)})`;
  }
}

/**
 * The approval category a human sees for this call. A `Bash` call is `git`
 * when it runs git, `destructive` when it matches a destructive pattern, and
 * `shell` otherwise.
 */
export function approvalCategoryFor(
  toolName: string,
  input: Record<string, unknown>,
  group: ToolGroupId | undefined,
): string {
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (looksDestructive(command)) return 'destructive';
    if (/^\s*git\b/.test(command)) return 'git';
    return 'shell';
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    return 'filesystem_write';
  }
  return group ? categoryForGroup(group) : 'external_api';
}

/** True when a Bash command is a git command (used to honour a `git` grant). */
export function isGitCommand(input: Record<string, unknown>): boolean {
  const command = typeof input.command === 'string' ? input.command : '';
  return /^\s*git\b/.test(command);
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
