import { describe, expect, it } from 'vitest';
import { ISOLATED_SETUP, type LocalSetup } from '@claude-team/domain';
import { resolveLocalSetup } from './claude-provider.js';

/**
 * The seam where "reuse my machine" becomes flags on a subprocess.
 *
 * Getting this wrong is silent in both directions: too little and the skills
 * and memory the user configured are invisible to their agents; too much and a
 * team behaves differently on the machine that happens to run it.
 */

const setup = (patch: Partial<LocalSetup> = {}): LocalSetup => ({ ...ISOLATED_SETUP, ...patch });

describe('local setup → SDK options', () => {
  it('is fully isolated when nothing is configured', () => {
    const resolved = resolveLocalSetup(undefined, {});
    expect(resolved.settingSources).toEqual([]);
    expect(resolved.useLocalMcpServers).toBe(false);
    // Omitted, not empty: an empty list would still turn the Skill tool on.
    expect('skills' in resolved).toBe(false);
    expect(resolved.pathToClaudeCodeExecutable).toBeUndefined();
  });

  it('passes the chosen setting sources through unchanged', () => {
    expect(resolveLocalSetup(setup({ settingSources: ['user', 'project'] }), {}).settingSources).toEqual([
      'user',
      'project',
    ]);
  });

  it('turns "none" into no skills at all, and "all" into every skill', () => {
    expect('skills' in resolveLocalSetup(setup({ skills: 'none' }), {})).toBe(false);
    expect(resolveLocalSetup(setup({ skills: 'all' }), {}).skills).toBe('all');
  });

  it('passes an explicit skill list, and treats an empty one as none', () => {
    expect(resolveLocalSetup(setup({ skills: ['pdf', 'laudo-de-bug'] }), {}).skills).toEqual([
      'pdf',
      'laudo-de-bug',
    ]);
    expect('skills' in resolveLocalSetup(setup({ skills: [] }), {})).toBe(false);
    expect('skills' in resolveLocalSetup(setup({ skills: ['  '] }), {})).toBe(false);
  });

  it('only loads the machine MCP servers when asked', () => {
    expect(resolveLocalSetup(setup({ mcpServers: true }), {}).useLocalMcpServers).toBe(true);
    expect(resolveLocalSetup(setup({ mcpServers: false }), {}).useLocalMcpServers).toBe(false);
  });

  it('prefers the setting over the provider default for both executable and sources', () => {
    const resolved = resolveLocalSetup(
      setup({ settingSources: ['local'], executablePath: '/opt/claude' }),
      { settingSources: ['user'], pathToClaudeCodeExecutable: '/bundled/claude' },
    );
    expect(resolved.settingSources).toEqual(['local']);
    expect(resolved.pathToClaudeCodeExecutable).toBe('/opt/claude');
  });

  it('falls back to the provider default when the activation carries no setup', () => {
    const resolved = resolveLocalSetup(undefined, {
      settingSources: ['user'],
      pathToClaudeCodeExecutable: '/bundled/claude',
    });
    expect(resolved.settingSources).toEqual(['user']);
    expect(resolved.pathToClaudeCodeExecutable).toBe('/bundled/claude');
  });
});
