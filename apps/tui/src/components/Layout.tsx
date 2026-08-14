import React from 'react';
import { Box, Text } from 'ink';
import { KEY_LEGEND, SECTIONS } from '@claude-team/ui-shared';
import { toneColor, UI } from '../theme.js';
import { useUi } from '../store.js';
import { Panel } from './ui.js';

export interface ViewProps {
  /** Rows available to the view body. */
  height: number;
  columns: number;
  narrow: boolean;
}

export function Header({ columns }: { columns: number }): React.JSX.Element {
  const ui = useUi();
  const compact = columns < 104;
  return (
    <Box>
      <Text bold color={UI.accent}>
        ▎claude-team{' '}
      </Text>
      {SECTIONS.map((section) => {
        const activeSection = ui.section === section.id;
        return (
          <Text key={section.id}>
            <Text
              color={activeSection ? 'black' : UI.dim}
              backgroundColor={activeSection ? UI.accent : undefined}
              bold={activeSection}
            >
              {` ${section.key}·${compact ? section.label.slice(0, 3) : section.label} `}
            </Text>
          </Text>
        );
      })}
      <Box flexGrow={1} />
      {ui.approvals.length > 0 ? (
        <Text color={toneColor('warning')} bold>
          {` ⚠ ${ui.approvals.length} approval(s) `}
        </Text>
      ) : null}
      {!compact ? <Text color={UI.dim}>{` ${ui.providerId} `}</Text> : null}
    </Box>
  );
}

export function StatusBar(): React.JSX.Element | null {
  const ui = useUi();
  if (!ui.status) return null;
  return (
    <Box>
      <Text color={toneColor(ui.status.tone)} wrap="truncate-end">
        {ui.status.tone === 'danger' ? '✗ ' : ui.status.tone === 'success' ? '✓ ' : '› '}
        {ui.status.message}
      </Text>
    </Box>
  );
}

export function Footer({ extra }: { extra?: Array<{ key: string; label: string }> }): React.JSX.Element {
  const hints = [...KEY_LEGEND, ...(extra ?? [])];
  return (
    <Box>
      <Text wrap="truncate-end">
        {hints.map((hint, index) => (
          <Text key={`${hint.key}-${hint.label}-${index}`}>
            {index > 0 ? <Text color={UI.dim}> · </Text> : null}
            <Text color={UI.accent}>{hint.key}</Text>
            <Text color={UI.dim}>{` ${hint.label}`}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}

export interface TwoPaneProps {
  listTitle: string;
  listSubtitle?: string;
  detailTitle: string;
  detailSubtitle?: string;
  list: React.ReactNode;
  detail: React.ReactNode;
  columns: number;
  narrow: boolean;
  /** Fraction of the width given to the list pane. */
  ratio?: number;
}

/**
 * List on the left, detail on the right — degrading to a single pane (the
 * focused one) when the terminal is too narrow to hold both.
 */
export function TwoPane({
  listTitle,
  listSubtitle,
  detailTitle,
  detailSubtitle,
  list,
  detail,
  columns,
  narrow,
  ratio = 0.38,
}: TwoPaneProps): React.JSX.Element {
  const ui = useUi();
  const listFocused = ui.focus === 'list';

  if (narrow) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Panel
          title={listFocused ? listTitle : detailTitle}
          subtitle={(listFocused ? listSubtitle : detailSubtitle) ?? 'tab switches panel'}
          focused
          width={columns}
          flexGrow={1}
        >
          {listFocused ? list : detail}
        </Panel>
      </Box>
    );
  }

  // Both panes get an explicit width: a long line must be clipped by its panel
  // rather than squeeze the other one.
  const listWidth = Math.max(24, Math.min(56, Math.round(columns * ratio)));

  return (
    <Box flexDirection="row" flexGrow={1} width={columns}>
      <Panel title={listTitle} subtitle={listSubtitle} focused={listFocused} width={listWidth}>
        {list}
      </Panel>
      <Panel
        title={detailTitle}
        subtitle={detailSubtitle}
        focused={!listFocused}
        width={columns - listWidth}
      >
        {detail}
      </Panel>
    </Box>
  );
}
