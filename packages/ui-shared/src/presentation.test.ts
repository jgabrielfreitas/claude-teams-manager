import { describe, expect, it } from 'vitest';
import {
  AGENT_STATUSES,
  MESSAGE_STATUSES,
  MESSAGE_TYPES,
  PERMISSION_MODES,
  RUN_STATUSES,
  TASK_STATUSES,
  AGENT_EFFORTS,
} from '@claude-team/domain';
import {
  AGENT_STATUS_UI,
  EFFORT_UI,
  MESSAGE_STATUS_UI,
  MESSAGE_TYPE_UI,
  PERMISSION_MODE_UI,
  RUN_STATUS_UI,
  TASK_STATUS_UI,
  formatDuration,
  formatRelative,
  progressBar,
  runDurationMs,
  truncate,
} from './presentation.js';

/**
 * The presentation vocabulary is what stops the same status from looking like
 * one thing in the terminal and another in the browser. These tests make a gap
 * in it a build failure rather than a visual surprise on one surface only.
 */

describe('every domain value has a presentation', () => {
  it('covers all statuses, types, efforts and permission modes', () => {
    for (const status of AGENT_STATUSES) expect(AGENT_STATUS_UI[status]).toBeDefined();
    for (const status of RUN_STATUSES) expect(RUN_STATUS_UI[status]).toBeDefined();
    for (const status of TASK_STATUSES) expect(TASK_STATUS_UI[status]).toBeDefined();
    for (const status of MESSAGE_STATUSES) expect(MESSAGE_STATUS_UI[status]).toBeDefined();
    for (const type of MESSAGE_TYPES) expect(MESSAGE_TYPE_UI[type]).toBeDefined();
    for (const effort of AGENT_EFFORTS) expect(EFFORT_UI[effort]).toBeDefined();
    for (const mode of PERMISSION_MODES) expect(PERMISSION_MODE_UI[mode]).toBeDefined();
  });

  it('gives permission modes the tones the security screen depends on', () => {
    // These drifted once (deny was red on one screen and grey on another).
    expect(PERMISSION_MODE_UI.allow.tone).toBe('success');
    expect(PERMISSION_MODE_UI.ask.tone).toBe('warning');
    expect(PERMISSION_MODE_UI.deny.tone).toBe('danger');
  });

  it('marks the states that mean work is happening', () => {
    expect(AGENT_STATUS_UI.working.busy).toBe(true);
    expect(AGENT_STATUS_UI.thinking.busy).toBe(true);
    expect(AGENT_STATUS_UI.idle.busy).toBeUndefined();
    expect(RUN_STATUS_UI.running.busy).toBe(true);
    expect(RUN_STATUS_UI.completed.busy).toBeUndefined();
  });
});

describe('run duration', () => {
  const now = new Date('2026-08-14T12:00:00Z').getTime();

  it('measures a finished run between its own timestamps', () => {
    expect(
      runDurationMs(
        {
          startedAt: new Date('2026-08-14T11:00:00Z'),
          completedAt: new Date('2026-08-14T11:30:00Z'),
        },
        now,
      ),
    ).toBe(30 * 60 * 1000);
  });

  it('measures a live run up to now', () => {
    expect(runDurationMs({ startedAt: new Date('2026-08-14T11:45:00Z') }, now)).toBe(15 * 60 * 1000);
  });

  it('accepts ISO strings, as they arrive over the wire', () => {
    expect(runDurationMs({ startedAt: '2026-08-14T11:45:00Z' }, now)).toBe(15 * 60 * 1000);
  });

  it('has no duration before it started', () => {
    expect(runDurationMs({}, now)).toBeUndefined();
    expect(runDurationMs({ startedAt: 'not a date' }, now)).toBeUndefined();
  });

  it('never reports negative time', () => {
    expect(
      runDurationMs(
        { startedAt: new Date('2026-08-14T11:30:00Z'), completedAt: new Date('2026-08-14T11:00:00Z') },
        now,
      ),
    ).toBe(0);
  });
});

describe('formatters', () => {
  it('formats durations across every magnitude', () => {
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(4_000)).toBe('4s');
    expect(formatDuration(95_000)).toBe('1m 35s');
    expect(formatDuration(3_930_000)).toBe('1h 05m');
  });

  it('formats relative times', () => {
    const now = Date.now();
    expect(formatRelative(undefined)).toBe('never');
    expect(formatRelative(new Date(now - 2_000), now)).toBe('just now');
    expect(formatRelative(new Date(now - 90_000), now)).toBe('1m ago');
    expect(formatRelative(new Date(now - 7_200_000), now)).toBe('2h ago');
  });

  it('truncates to a single line', () => {
    expect(truncate('a\n  b   c', 40)).toBe('a b c');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });

  it('draws a bounded progress bar', () => {
    expect(progressBar(0, 10)).toBe('░'.repeat(10));
    expect(progressBar(100, 10)).toBe('█'.repeat(10));
    expect(progressBar(50, 10)).toBe(`${'█'.repeat(5)}${'░'.repeat(5)}`);
    // Out-of-range input must not produce a broken bar.
    expect(progressBar(-20, 10)).toHaveLength(10);
    expect(progressBar(500, 10)).toHaveLength(10);
  });
});
