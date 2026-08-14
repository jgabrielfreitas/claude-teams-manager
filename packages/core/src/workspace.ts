import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const exec = promisify(execFile);

/**
 * Workspace inspection, including git awareness.
 *
 * Both UIs show the same information, so the reading happens once, here.
 * The shape is deliberately future-proof for worktree isolation (ADR-002):
 * `WorkspaceInfo` already describes a checkout, not "the" checkout.
 */

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  /** Number of files with uncommitted changes. */
  dirtyFiles: number;
  /** Short summary of the most recent commit. */
  lastCommit?: string;
  remote?: string;
  ahead?: number;
  behind?: number;
  /** True when this checkout is a linked worktree rather than the main one. */
  isWorktree?: boolean;
}

export interface WorkspaceInfo {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  git: GitInfo;
}

/** Expands `~`, resolves relative paths, and normalises separators. */
export function expandPath(input: string, base = process.cwd()): string {
  const trimmed = input.trim();
  if (!trimmed) return base;
  const expanded = trimmed.startsWith('~')
    ? trimmed.replace(/^~(?=$|\/)/, homedir())
    : trimmed;
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git', args, { cwd, timeout: 8000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export async function inspectWorkspace(path: string): Promise<WorkspaceInfo> {
  const resolved = expandPath(path);
  let exists = false;
  let isDirectory = false;
  try {
    await access(resolved);
    exists = true;
    isDirectory = (await stat(resolved)).isDirectory();
  } catch {
    return { path: resolved, exists: false, isDirectory: false, git: { isRepo: false, dirtyFiles: 0 } };
  }

  if (!isDirectory) {
    return { path: resolved, exists, isDirectory, git: { isRepo: false, dirtyFiles: 0 } };
  }

  const inside = await git(resolved, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    return { path: resolved, exists, isDirectory, git: { isRepo: false, dirtyFiles: 0 } };
  }

  const [branch, status, lastCommit, remote, tracking, commonDir, gitDir] = await Promise.all([
    git(resolved, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(resolved, ['status', '--porcelain']),
    git(resolved, ['log', '-1', '--pretty=%h %s']),
    git(resolved, ['remote', 'get-url', 'origin']),
    git(resolved, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
    git(resolved, ['rev-parse', '--git-common-dir']),
    git(resolved, ['rev-parse', '--git-dir']),
  ]);

  let ahead: number | undefined;
  let behind: number | undefined;
  if (tracking) {
    const [a, b] = tracking.split(/\s+/).map((n) => Number.parseInt(n, 10));
    if (Number.isFinite(a)) ahead = a;
    if (Number.isFinite(b)) behind = b;
  }

  return {
    path: resolved,
    exists,
    isDirectory,
    git: {
      isRepo: true,
      branch: branch || undefined,
      dirtyFiles: status ? status.split('\n').filter(Boolean).length : 0,
      lastCommit: lastCommit || undefined,
      remote: remote || undefined,
      ahead,
      behind,
      isWorktree: Boolean(commonDir && gitDir && commonDir !== gitDir),
    },
  };
}

/** One-line description used in prompts and dense UI rows. */
export function describeGit(info: WorkspaceInfo): string | undefined {
  if (!info.git.isRepo) return undefined;
  const parts = [`git branch ${info.git.branch ?? 'detached'}`];
  parts.push(info.git.dirtyFiles === 0 ? 'clean' : `${info.git.dirtyFiles} uncommitted file(s)`);
  if (info.git.lastCommit) parts.push(`last commit: ${info.git.lastCommit}`);
  if (info.git.isWorktree) parts.push('(linked worktree)');
  return parts.join(', ');
}
