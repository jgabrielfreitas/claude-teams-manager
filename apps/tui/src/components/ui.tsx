import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { StatusDescriptor, Tone } from '@claude-team/ui-shared';
import { borderColor, toneColor, UI } from '../theme.js';

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

export interface PanelProps {
  title: string;
  subtitle?: string;
  focused?: boolean;
  /** Fixed width in columns; omit to grow. */
  width?: number;
  flexGrow?: number;
  children: React.ReactNode;
}

export function Panel({ title, subtitle, focused, width, flexGrow, children }: PanelProps): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor(Boolean(focused))}
      width={width}
      flexGrow={flexGrow}
      // Never shrink below the width we asked for: long content must be
      // clipped by the panel, not allowed to squeeze the layout.
      flexShrink={0}
      paddingX={1}
      overflow="hidden"
    >
      <Box>
        <Text bold color={focused ? UI.accent : 'white'}>
          {focused ? '▌' : ' '}
          {title}
        </Text>
        {subtitle ? <Text color={UI.dim}> {subtitle}</Text> : null}
      </Box>
      {/*
        No `overflow: hidden` here on purpose: it would let dense rows shrink
        below their content and wrap. The panel above clips instead.
      */}
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}

/** A dense `label  value` line. */
export function Field({
  label,
  value,
  tone,
  width = 14,
}: {
  label: string;
  value: React.ReactNode;
  tone?: Tone;
  width?: number;
}): React.JSX.Element {
  return (
    <Box>
      <Box width={width} flexShrink={0}>
        <Text color={UI.dim}>{label}</Text>
      </Box>
      {typeof value === 'string' || typeof value === 'number' ? (
        <Text color={tone ? toneColor(tone) : undefined} wrap="truncate-end">
          {String(value)}
        </Text>
      ) : (
        value
      )}
    </Box>
  );
}

/** Status glyph + label, coloured by the shared tone mapping. */
export function StatusChip({
  status,
  showLabel = true,
  spin = true,
}: {
  status: StatusDescriptor;
  showLabel?: boolean;
  spin?: boolean;
}): React.JSX.Element {
  const color = toneColor(status.tone);
  return (
    <Text color={color}>
      {status.busy && spin ? <Spinner type="dots" /> : status.glyph}
      {showLabel ? ` ${status.label}` : ''}
    </Text>
  );
}

export function Dim({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <Text color={UI.dim}>{children}</Text>;
}

export function Toned({ tone, children, bold }: { tone: Tone; children: React.ReactNode; bold?: boolean }) {
  return (
    <Text color={toneColor(tone)} bold={bold}>
      {children}
    </Text>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Box marginTop={1}>
      <Text bold color={UI.accent}>
        {children}
      </Text>
    </Box>
  );
}

export function EmptyState({ title, hints }: { title: string; hints?: string[] }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={UI.dim}>{title}</Text>
      {(hints ?? []).map((hint) => (
        <Text key={hint} color={UI.dim}>
          {'  '}· {hint}
        </Text>
      ))}
    </Box>
  );
}

export function ErrorLine({ message }: { message: string }): React.JSX.Element {
  return (
    <Text color={toneColor('danger')} wrap="truncate-end">
      ✗ {message}
    </Text>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }): React.JSX.Element {
  return (
    <Text color={UI.dim}>
      <Spinner type="dots" /> {label}…
    </Text>
  );
}

/** Keyboard hint list, e.g. `[c] create  [e] edit`. */
export function KeyHints({ hints }: { hints: Array<{ key: string; label: string }> }): React.JSX.Element {
  return (
    <Text wrap="truncate-end">
      {hints.map((hint, index) => (
        <Text key={hint.key + hint.label}>
          {index > 0 ? '  ' : ''}
          <Text color={UI.accent}>{hint.key}</Text>
          <Text color={UI.dim}> {hint.label}</Text>
        </Text>
      ))}
    </Text>
  );
}

/* ------------------------------------------------------------------ *
 * List rows
 * ------------------------------------------------------------------ */

export function ListRow({
  selected,
  focused,
  children,
}: {
  selected: boolean;
  focused: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box>
      <Text color={selected ? (focused ? UI.accent : 'white') : undefined} bold={selected}>
        {selected ? '❯ ' : '  '}
      </Text>
      {/* Column direction so the row content stretches to the full width. */}
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        {children}
      </Box>
    </Box>
  );
}

/** `····· 12 more` marker for lists that do not fit. */
export function MoreRow({ count }: { count: number }): React.JSX.Element | null {
  if (count <= 0) return null;
  return <Text color={UI.dim}>{`  … ${count} more`}</Text>;
}
