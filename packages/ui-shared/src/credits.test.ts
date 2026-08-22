import { describe, expect, it } from 'vitest';
import { availableCommands, sectionsFor } from './commands.js';
import {
  CONTRIBUTORS,
  PROJECT_FACTS,
  noise,
  pulse,
  shimmerAt,
  starfield,
  typewriter,
  typewriterDone,
} from './credits.js';

/**
 * The credits screen is decoration, but its numbers are claims and its
 * animation is arithmetic — both can be wrong, and both are cheap to hold to
 * account.
 */

describe('who is credited', () => {
  it('adds up to the repository it claims to describe', () => {
    const counted = CONTRIBUTORS.reduce((sum, person) => sum + person.commits, 0);
    expect(counted).toBe(PROJECT_FACTS.commits);
  });

  it('says something about every contributor, not just a name', () => {
    for (const person of CONTRIBUTORS) {
      expect(person.name.trim().length).toBeGreaterThan(0);
      expect(person.role.trim().length).toBeGreaterThan(0);
      expect(person.commits).toBeGreaterThan(0);
    }
  });
});

describe('shimmer', () => {
  it('lights one place at a time and fades behind it', () => {
    const length = 20;
    const lit = Array.from({ length }, (_, index) => shimmerAt(index, 6, length));
    expect(Math.max(...lit)).toBe(1);
    // The head is brightest and the tail decreases; nothing ahead is lit.
    expect(lit[6]).toBe(1);
    expect(lit[5]!).toBeLessThan(lit[6]!);
    expect(lit[7]).toBe(0);
  });

  it('wraps instead of running off the end for ever', () => {
    const length = 10;
    const anyLit = (tick: number) =>
      Array.from({ length }, (_, index) => shimmerAt(index, tick, length)).some((v) => v > 0);
    expect(anyLit(3)).toBe(true);
    // A tick far in the future still lights something: the sweep repeats.
    expect(anyLit(3 + (length + 8) * 5)).toBe(true);
  });

  it('is silent for an empty title rather than dividing by zero', () => {
    expect(shimmerAt(0, 5, 0)).toBe(0);
  });
});

describe('starfield', () => {
  it('draws exactly the requested grid', () => {
    const sky = starfield(40, 5, 0);
    expect(sky).toHaveLength(5);
    for (const row of sky) expect(row).toHaveLength(40);
  });

  it('is the same sky for the same tick — no jitter between renders', () => {
    expect(starfield(60, 6, 12)).toEqual(starfield(60, 6, 12));
  });

  it('moves', () => {
    // Enough ticks to shift a column at the default speed.
    expect(starfield(60, 6, 0).join('')).not.toEqual(starfield(60, 6, 9).join(''));
  });

  it('leaves mostly sky', () => {
    const filled = starfield(120, 10, 3).join('').replace(/ /g, '').length;
    expect(filled).toBeGreaterThan(0);
    expect(filled).toBeLessThan(120 * 10 * 0.2);
  });

  it('survives a terminal with no room in it', () => {
    expect(starfield(0, 5, 1)).toEqual([]);
    expect(starfield(40, 0, 1)).toEqual([]);
  });
});

describe('noise', () => {
  it('is deterministic and bounded', () => {
    for (const [x, y] of [[0, 0], [3, 7], [-11, 2]] as const) {
      const value = noise(x, y);
      expect(value).toBe(noise(x, y));
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('typewriter', () => {
  it('reveals over time and then stops', () => {
    const text = 'obrigado';
    expect(typewriter(text, 0)).toBe('');
    expect(typewriter(text, 2, 2)).toBe('obri');
    expect(typewriter(text, 100, 2)).toBe(text);
    expect(typewriterDone(text, 100, 2)).toBe(true);
    expect(typewriterDone(text, 1, 2)).toBe(false);
  });

  it('can start late, so lines can be staggered without their own clocks', () => {
    expect(typewriter('abcd', 5, 1, 5)).toBe('');
    expect(typewriter('abcd', 7, 1, 5)).toBe('ab');
  });
});

describe('pulse', () => {
  it('breathes between 0 and 1 without a discontinuity at the turn', () => {
    const period = 20;
    expect(pulse(0, period)).toBe(0);
    expect(pulse(period / 2, period)).toBe(1);
    expect(pulse(period, period)).toBe(0);
    const rising = pulse(4, period);
    const falling = pulse(period - 4, period);
    expect(rising).toBeCloseTo(falling, 10);
  });
});

describe('where the credits screen shows up', () => {
  it('is a section in the terminal and nowhere else', () => {
    expect(sectionsFor('tui').map((s) => s.id)).toContain('credits');
    // The browser has no such page; offering the link would be a dead end.
    expect(sectionsFor('web').map((s) => s.id)).not.toContain('credits');
  });

  it('is in the terminal palette and not the browser one', () => {
    const ids = (surface: 'tui' | 'web') => availableCommands({ surface }).map((c) => c.id);
    expect(ids('tui')).toContain('nav.credits');
    expect(ids('web')).not.toContain('nav.credits');
  });

  it('hides surface-specific commands from a caller that does not say which it is', () => {
    // Failing closed: a palette entry that does nothing when chosen is the bug
    // this guards against.
    expect(availableCommands({}).map((c) => c.id)).not.toContain('nav.credits');
  });
});
