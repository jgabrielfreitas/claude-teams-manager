import { describe, expect, it } from 'vitest';
import { permissionsFromGroups, type ToolPermission } from '@claude-team/domain';
import {
  approvalCategoryFor,
  describeToolCall,
  groupForTool,
  isGitCommand,
  resolveToolGrants,
} from './tool-mapping.js';
import { toClaudeEffort, toThinkingBudget } from './effort-adapter.js';

const perms = (spec: Record<string, 'allow' | 'ask' | 'deny'>): ToolPermission[] =>
  permissionsFromGroups([]).map((p) => ({ group: p.group, mode: spec[p.group] ?? 'deny' }));

describe('capability → tool resolution', () => {
  it('auto-allows tools whose capability is allowed', () => {
    const grants = resolveToolGrants(perms({ filesystem_read: 'allow' }), []);
    expect(grants.allowedTools).toContain('Read');
    expect(grants.allowedTools).toContain('Grep');
    expect(grants.disallowedTools).toContain('Write');
  });

  it('routes an "ask" capability through the permission callback', () => {
    const grants = resolveToolGrants(perms({ filesystem_write: 'ask' }), []);
    expect(grants.askTools).toContain('Write');
    expect(grants.allowedTools).not.toContain('Write');
    expect(grants.disallowedTools).not.toContain('Write');
  });

  it('removes denied tools from the agent entirely', () => {
    const grants = resolveToolGrants(perms({ filesystem_read: 'allow', terminal: 'deny', git: 'deny' }), []);
    expect(grants.disallowedTools).toContain('Bash');
    expect(grants.allowedTools).not.toContain('Bash');
  });

  it('downgrades Bash to "ask" when git is granted but the shell is not', () => {
    // The callback then allows `git ...` and denies everything else.
    const grants = resolveToolGrants(perms({ terminal: 'deny', git: 'allow' }), []);
    expect(grants.askTools).toContain('Bash');
    expect(grants.disallowedTools).not.toContain('Bash');
  });

  it('always includes the host-implemented team tools', () => {
    const grants = resolveToolGrants(perms({}), ['mcp__team__send_message']);
    expect(grants.allowedTools).toContain('mcp__team__send_message');
  });
});

describe('tool → capability reverse lookup', () => {
  it('classifies built-ins, MCP tools and our own tools', () => {
    expect(groupForTool('Read', 'team')).toBe('filesystem_read');
    expect(groupForTool('Write', 'team')).toBe('filesystem_write');
    expect(groupForTool('WebFetch', 'team')).toBe('network');
    expect(groupForTool('mcp__team__ask_agent', 'team')).toBe('agent_messaging');
    expect(groupForTool('mcp__linear__create_issue', 'team')).toBe('mcp');
    expect(groupForTool('mcp__playwright__click', 'team')).toBe('browser');
    expect(groupForTool('SomethingNew', 'team')).toBeUndefined();
  });
});

describe('approval categories', () => {
  it('separates git, destructive and ordinary shell commands', () => {
    expect(approvalCategoryFor('Bash', { command: 'git status' }, 'terminal')).toBe('git');
    expect(approvalCategoryFor('Bash', { command: 'rm -rf ./generated' }, 'terminal')).toBe(
      'destructive',
    );
    expect(approvalCategoryFor('Bash', { command: 'npm test' }, 'terminal')).toBe('shell');
    expect(approvalCategoryFor('Bash', { command: 'git push --force' }, 'terminal')).toBe(
      'destructive',
    );
    expect(approvalCategoryFor('Write', { file_path: '/tmp/a' }, 'filesystem_write')).toBe(
      'filesystem_write',
    );
  });

  it('recognises git commands', () => {
    expect(isGitCommand({ command: '  git commit -m x' })).toBe(true);
    expect(isGitCommand({ command: 'echo git' })).toBe(false);
  });

  it('describes a call in terms a human can approve', () => {
    expect(describeToolCall('Bash', { command: 'rm -rf ./generated' })).toBe(
      'Run shell command: rm -rf ./generated',
    );
    expect(describeToolCall('Write', { file_path: '/tmp/x.ts' })).toBe('Write file: /tmp/x.ts');
    expect(describeToolCall('WebFetch', { url: 'https://example.com' })).toBe(
      'Fetch URL: https://example.com',
    );
  });
});

describe('effort adapter', () => {
  it('maps every domain level to a provider level', () => {
    expect(toClaudeEffort('low')).toBe('low');
    expect(toClaudeEffort('medium')).toBe('medium');
    expect(toClaudeEffort('high')).toBe('high');
    expect(toClaudeEffort('max')).toBe('max');
  });

  it('offers a thinking-budget fallback that grows with effort', () => {
    expect(toThinkingBudget('low')).toBeUndefined();
    expect(toThinkingBudget('medium')!).toBeLessThan(toThinkingBudget('high')!);
    expect(toThinkingBudget('high')!).toBeLessThan(toThinkingBudget('max')!);
  });
});
