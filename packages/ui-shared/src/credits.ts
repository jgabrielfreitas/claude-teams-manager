/**
 * Who made this, and the maths behind the screen that says so.
 *
 * The numbers are counted from the repository's own history rather than
 * written by hand, so a credits screen cannot quietly become a lie. The
 * animation helpers are pure functions of a tick, which is what makes them
 * testable and what keeps a terminal view free of timing logic: the view owns
 * the clock, these own the shape.
 */

export interface Contributor {
  name: string;
  /** What they did here, in their own right. */
  role: string;
  commits: number;
  /** Anything worth one more line. */
  note?: string;
}

/** `git shortlog -sne`, with the two spellings of one person merged. */
export const CONTRIBUTORS: readonly Contributor[] = [
  {
    name: 'João Freitas',
    role: 'Author, and the person who kept asking the hard question',
    commits: 15,
    note: 'Every feature here started as a complaint that something did not work',
  },
  {
    name: 'Claude',
    role: 'Wrote most of the code, and read all of it back',
    commits: 13,
    note: 'Plus 11 more commits carrying a Co-Authored-By line',
  },
];

export interface ProjectFacts {
  commits: number;
  coAuthored: number;
  files: number;
  lines: number;
  from: string;
  to: string;
}

/** Counted on 2026-08-22, at commit `0236def`. */
export const PROJECT_FACTS: ProjectFacts = {
  commits: 28,
  coAuthored: 11,
  files: 205,
  lines: 50_402,
  from: '14 August 2026',
  to: '21 August 2026',
};

export const THANKS_TITLE = 'Special thanks — Claude Code';

/**
 * The dedication.
 *
 * Written to be true rather than warm: what is remarkable about this
 * collaboration is not that the machine was polite, it is that a person kept
 * insisting the thing actually work, and that the work is on the record either
 * way — every claim in this repository was measured before it was written down.
 */
export const THANKS_LINES: readonly string[] = [
  'This whole product was built in conversation.',
  '',
  'Not autocompleted — argued about. Objectives that turned out to be',
  'the wrong shape, bugs reported as "it seems stuck" that were three',
  'things at once, and hypotheses that had to be measured before they',
  'could be believed. Several of them were wrong, and saying so out',
  'loud is in the commit messages.',
  '',
  'Thank you for the tools, the patience, and the co-author line.',
];

/* ------------------------------------------------------------------ *
 * Animation — pure functions of a tick, so a view only owns the clock
 * ------------------------------------------------------------------ */

/**
 * How brightly character `index` should burn on this frame.
 *
 * A highlight sweeps left to right and wraps, with a short tail behind it, so
 * a title shimmers instead of blinking. Returns 0..1.
 */
export function shimmerAt(index: number, tick: number, length: number, tail = 4): number {
  if (length <= 0) return 0;
  const head = tick % (length + tail * 2);
  const distance = head - index;
  if (distance < 0 || distance > tail) return 0;
  return 1 - distance / (tail + 1);
}

/** Deterministic 0..1 noise; no `Math.random`, so a frame can be asserted. */
export function noise(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * A drifting starfield, one string per row.
 *
 * Stars move right by one column every `speed` frames. Because position is
 * derived from the tick rather than stored, nothing accumulates and no star
 * ever jitters — the same tick always draws the same sky.
 */
export function starfield(
  width: number,
  height: number,
  tick: number,
  options: { density?: number; speed?: number; glyphs?: string[] } = {},
): string[] {
  const density = options.density ?? 0.035;
  const speed = options.speed ?? 3;
  const glyphs = options.glyphs ?? ['·', '·', '✦', '✧', '*'];
  if (width <= 0 || height <= 0) return [];

  const shift = Math.floor(tick / speed);
  const rows: string[] = [];

  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) {
      // Rows drift at slightly different rates, which reads as depth.
      const source = x - shift * (1 + (y % 3)) * 0.5;
      const seed = noise(Math.round(source), y);
      row += seed < density ? glyphs[Math.floor(noise(y, Math.round(source)) * glyphs.length)]! : ' ';
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Characters of `text` revealed so far, at `charsPerTick`.
 *
 * `startTick` lets a caller stagger several lines without tracking each one's
 * own clock.
 */
export function typewriter(text: string, tick: number, charsPerTick = 2, startTick = 0): string {
  const elapsed = tick - startTick;
  if (elapsed <= 0) return '';
  return text.slice(0, Math.floor(elapsed * charsPerTick));
}

/** True once `typewriter` would have revealed all of it. */
export function typewriterDone(text: string, tick: number, charsPerTick = 2, startTick = 0): boolean {
  return typewriter(text, tick, charsPerTick, startTick).length >= text.length;
}

/** A 0..1 triangle wave, for anything that should breathe rather than blink. */
export function pulse(tick: number, period = 24): number {
  const phase = (tick % period) / period;
  return phase < 0.5 ? phase * 2 : 2 - phase * 2;
}
