import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

/**
 * Environment detection for onboarding.
 *
 * The wizard's rule is "never ask for something we can find out", so this
 * module answers as much of the setup questionnaire as possible before the
 * first prompt is shown.
 */

export interface McpServerInfo {
  name: string;
  scope: 'user' | 'project';
  transport: string;
}

export interface SkillInfo {
  name: string;
  scope: 'user' | 'project';
  description?: string;
}

export interface ClaudeEnvironment {
  /** Path to the `claude` executable, when it is on PATH. */
  cliPath?: string;
  cliVersion?: string;
  cliInstalled: boolean;

  /** True when we found credentials the SDK can use without further setup. */
  authenticated: boolean;
  /** How authentication was found: `api_key`, `subscription`, or `unknown`. */
  authMethod: 'api_key' | 'subscription' | 'none';

  /** MCP servers already configured on this machine. */
  mcpServers: McpServerInfo[];

  /** Skills installed on this machine, for the local-setup screen. */
  skills: SkillInfo[];

  /** Command-line tools available to agents, for capability suggestions. */
  availableTools: string[];

  sdkInstalled: boolean;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function which(command: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('which', [command], { timeout: 5000 });
    const path = stdout.trim().split('\n')[0];
    return path || undefined;
  } catch {
    return undefined;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function detectClaudeEnvironment(cwd = process.cwd()): Promise<ClaudeEnvironment> {
  const home = homedir();

  const [cliPath, claudeJson, credentials, projectMcp, sdkInstalled, skills] = await Promise.all([
    which('claude'),
    readJson(join(home, '.claude.json')),
    fileExists(join(home, '.claude', '.credentials.json')),
    readJson(join(cwd, '.mcp.json')),
    resolveSdk(),
    listLocalSkills(cwd),
  ]);

  let cliVersion: string | undefined;
  if (cliPath) {
    try {
      const { stdout } = await exec(cliPath, ['--version'], { timeout: 10_000 });
      cliVersion = stdout.trim();
    } catch {
      /* version is a nice-to-have */
    }
  }

  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  // A logged-in Claude Code writes an oauth entry into ~/.claude.json.
  const hasSubscription =
    credentials ||
    Boolean(claudeJson?.oauthAccount) ||
    Boolean(claudeJson?.userID) ||
    Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim());

  const mcpServers: McpServerInfo[] = [];
  collectMcpServers(claudeJson?.mcpServers, 'user', mcpServers);
  collectMcpServers(projectMcp?.mcpServers, 'project', mcpServers);
  // Per-project MCP servers also live under `projects[cwd].mcpServers`.
  const projects = claudeJson?.projects as Record<string, { mcpServers?: unknown }> | undefined;
  collectMcpServers(projects?.[cwd]?.mcpServers, 'project', mcpServers);

  const candidates = ['git', 'node', 'pnpm', 'npm', 'python3', 'docker', 'rg', 'gh'];
  const found = await Promise.all(
    candidates.map(async (c) => ((await which(c)) ? c : undefined)),
  );

  return {
    cliPath,
    cliVersion,
    cliInstalled: Boolean(cliPath),
    authenticated: hasApiKey || Boolean(hasSubscription),
    authMethod: hasApiKey ? 'api_key' : hasSubscription ? 'subscription' : 'none',
    mcpServers,
    skills,
    availableTools: found.filter(Boolean) as string[],
    sdkInstalled,
  };
}

function collectMcpServers(raw: unknown, scope: 'user' | 'project', out: McpServerInfo[]): void {
  if (!raw || typeof raw !== 'object') return;
  for (const [name, config] of Object.entries(raw as Record<string, unknown>)) {
    if (out.some((s) => s.name === name)) continue;
    const cfg = (config ?? {}) as Record<string, unknown>;
    const transport =
      typeof cfg.type === 'string'
        ? cfg.type
        : cfg.url
          ? 'http'
          : cfg.command
            ? 'stdio'
            : 'unknown';
    out.push({ name, scope, transport });
  }
}

/**
 * MCP servers configured on this machine, with their full configuration.
 *
 * `detectClaudeEnvironment` reports that they exist; this returns what the SDK
 * needs to actually connect to them, and is only called when the user has
 * opted into reusing them. Project scope wins over user scope, which is how
 * the CLI resolves the same collision.
 *
 * Note that servers authenticated interactively (an OAuth login done inside
 * Claude Code) may not connect from a background process — a stdio server
 * started from a command always will.
 */
export async function loadLocalMcpServers(cwd = process.cwd()): Promise<Record<string, unknown>> {
  const home = homedir();
  const [claudeJson, projectMcp] = await Promise.all([
    readJson(join(home, '.claude.json')),
    readJson(join(cwd, '.mcp.json')),
  ]);
  const projects = claudeJson?.projects as Record<string, { mcpServers?: unknown }> | undefined;

  const servers: Record<string, unknown> = {};
  for (const source of [claudeJson?.mcpServers, projects?.[cwd]?.mcpServers, projectMcp?.mcpServers]) {
    if (!source || typeof source !== 'object') continue;
    for (const [name, config] of Object.entries(source as Record<string, unknown>)) {
      if (config && typeof config === 'object') servers[name] = config;
    }
  }
  return servers;
}

/**
 * Skills discovered under `~/.claude/skills` and the workspace's own
 * `.claude/skills`, so the setting can offer names instead of asking the user
 * to remember them. The SDK does its own discovery when skills are enabled;
 * this is only for showing the list.
 */
export async function listLocalSkills(cwd = process.cwd()): Promise<SkillInfo[]> {
  const found: SkillInfo[] = [];
  const roots: Array<{ dir: string; scope: 'user' | 'project' }> = [
    { dir: join(homedir(), '.claude', 'skills'), scope: 'user' },
    { dir: join(cwd, '.claude', 'skills'), scope: 'project' },
  ];

  for (const { dir, scope } of roots) {
    let entries: string[];
    try {
      entries = (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.some((s) => s.name === entry)) continue;
      const meta = await readSkillMeta(join(dir, entry, 'SKILL.md'));
      if (!meta) continue;
      found.push({ name: meta.name ?? entry, scope, ...(meta.description ? { description: meta.description } : {}) });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

async function readSkillMeta(
  path: string,
): Promise<{ name?: string; description?: string } | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  // Front matter only; a full YAML parse is not worth a dependency here.
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const meta: { name?: string; description?: string } = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const value = kv[2]!.trim().replace(/^['"]|['"]$/g, '');
    if (kv[1] === 'name') meta.name = value;
    else meta.description = value;
  }
  return meta;
}

async function resolveSdk(): Promise<boolean> {
  try {
    await import('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch {
    return false;
  }
}

/** A short, human-readable summary for the onboarding screen. */
export function summariseEnvironment(env: ClaudeEnvironment): string[] {
  const lines: string[] = [];
  lines.push(
    env.cliInstalled
      ? `Claude CLI found${env.cliVersion ? ` (${env.cliVersion})` : ''}`
      : 'Claude CLI not found on PATH',
  );
  lines.push(
    env.authenticated
      ? `Authenticated via ${env.authMethod === 'api_key' ? 'ANTHROPIC_API_KEY' : 'your Claude subscription'}`
      : 'Not authenticated — run `claude` once to log in, or set ANTHROPIC_API_KEY',
  );
  lines.push(
    env.mcpServers.length > 0
      ? `${env.mcpServers.length} MCP server(s): ${env.mcpServers.map((s) => s.name).join(', ')}`
      : 'No MCP servers configured',
  );
  lines.push(
    env.skills.length > 0
      ? `${env.skills.length} skill(s) installed: ${env.skills.slice(0, 6).map((s) => s.name).join(', ')}`
      : 'No skills installed',
  );
  if (env.availableTools.length) lines.push(`Tools available: ${env.availableTools.join(', ')}`);
  return lines;
}
