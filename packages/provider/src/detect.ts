import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access } from 'node:fs/promises';
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

  const [cliPath, claudeJson, credentials, projectMcp, sdkInstalled] = await Promise.all([
    which('claude'),
    readJson(join(home, '.claude.json')),
    fileExists(join(home, '.claude', '.credentials.json')),
    readJson(join(cwd, '.mcp.json')),
    resolveSdk(),
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
  if (env.availableTools.length) lines.push(`Tools available: ${env.availableTools.join(', ')}`);
  return lines;
}
