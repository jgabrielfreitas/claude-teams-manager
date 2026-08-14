import type { Tone } from '@claude-team/ui-shared';

/**
 * The one place where a shared `Tone` becomes an Ink colour.
 *
 * "Running is green, blocked is amber, failed is red" is decided once in
 * `@claude-team/ui-shared`; this file only says what those tones look like in
 * a terminal. Nothing else in the TUI may hard-code a status colour.
 */
const TONE_COLORS: Record<Tone, string> = {
  neutral: 'white',
  muted: 'gray',
  info: 'cyan',
  active: 'greenBright',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
};

export function toneColor(tone: Tone): string {
  return TONE_COLORS[tone] ?? 'white';
}

/** Chrome colours, deliberately few. */
export const UI = {
  accent: 'cyan',
  borderFocused: 'cyan',
  borderIdle: 'gray',
  dim: 'gray',
  headerBg: 'cyan',
} as const;

export function borderColor(focused: boolean): string {
  return focused ? UI.borderFocused : UI.borderIdle;
}
