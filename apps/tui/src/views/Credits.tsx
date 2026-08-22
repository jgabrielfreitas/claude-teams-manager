import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  CONTRIBUTORS,
  PROJECT_FACTS,
  THANKS_LINES,
  THANKS_TITLE,
  progressBar,
  pulse,
  shimmerAt,
  starfield,
  typewriter,
  typewriterDone,
} from '@claude-team/ui-shared';
import { toneColor, UI } from '../theme.js';
import { useKeys } from '../lib/hooks.js';
import { useUi } from '../store.js';
import { KeyHints } from '../components/ui.js';
import type { ViewProps } from '../components/Layout.js';

/**
 * Who made this.
 *
 * The one screen in the product that exists to be looked at rather than used,
 * so it is allowed a starfield. Everything moving here is a pure function of a
 * frame counter (`@claude-team/ui-shared/credits`), which keeps the timing in
 * one place and the shapes under test — this file owns the clock and nothing
 * else.
 *
 * The clock stops when the view unmounts and when the reader presses space. A
 * terminal that redraws twelve times a second for ever, in a section nobody is
 * looking at, is a bug however pretty it is.
 */

const FRAME_MS = 80;
const TITLE = 'CLAUDE TEAM MANAGER';

export function CreditsView({ height, columns, narrow }: ViewProps): React.JSX.Element {
  const ui = useUi();
  const [tick, setTick] = useState(0);
  const [running, setRunning] = useState(true);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((current) => current + 1), FRAME_MS);
    return () => clearInterval(timer);
  }, [running]);

  useKeys(
    (input) => {
      if (input === ' ') setRunning((current) => !current);
      else if (input === 'r') setTick(0);
    },
    ui.lock === 'view',
  );

  const width = Math.max(20, columns - 2);

  /*
   * Every row is budgeted, because Ink clips a box that asks for more than it
   * was given and the clipping lands wherever it lands: the first version of
   * this screen lost the contributors' names and overlapped the dedication on
   * a 44-row terminal. Ornament is dropped first, in order, and the words
   * survive to the smallest window.
   */
  const fixed = 1 /* title */ + 1 /* facts */ + 1 /* hints */ + 4 /* thanks frame */;
  const showNotes = height >= 32;
  const showRoles = height >= 24;
  const perPerson = 1 + (showRoles ? 1 : 0) + (showNotes ? 1 : 0) + (narrow ? 0 : 1);
  const people = CONTRIBUTORS.length * perPerson + 1;
  const skyRows = height >= 34 ? 3 : height >= 28 ? 2 : height >= 22 ? 1 : 0;
  const thanksRoom = Math.max(1, height - fixed - people - skyRows - 1);
  // When the dedication does not fit, the cut comes out of the middle: the
  // opening line and the thank-you are the two that must survive a small
  // window, and dropping from the end would lose exactly the wrong one.
  const thanks =
    THANKS_LINES.length <= thanksRoom
      ? [...THANKS_LINES]
      : [...THANKS_LINES.slice(0, Math.max(1, thanksRoom - 1)), THANKS_LINES[THANKS_LINES.length - 1]!];

  const sky = useMemo(
    () => (skyRows > 0 ? starfield(width, skyRows, tick) : []),
    [width, skyRows, tick],
  );

  // The dedication types itself out, one line after the previous one finished.
  const starts: number[] = [];
  let cursor = 14;
  for (const line of thanks) {
    starts.push(cursor);
    cursor += Math.ceil((line.length || 8) / 3) + 2;
  }

  const glow = pulse(tick, 34);
  const frameColor = glow > 0.6 ? UI.accent : UI.dim;

  return (
    <Box flexDirection="column" width={columns} height={height}>
      {/* ---- title, with a highlight sweeping across it ---- */}
      <Box justifyContent="center" marginTop={1}>
        <Text>
          {TITLE.split('').map((char, index) => {
            const heat = shimmerAt(index, tick, TITLE.length + 6);
            return (
              <Text
                key={`${char}-${index}`}
                bold={heat > 0.2}
                color={heat > 0.6 ? 'whiteBright' : heat > 0.2 ? UI.accent : UI.dim}
              >
                {char}
                {index < TITLE.length - 1 ? ' ' : ''}
              </Text>
            );
          })}
        </Text>
      </Box>

      <Box justifyContent="center">
        <Text color={UI.dim} wrap="truncate-end">
          {PROJECT_FACTS.commits} commits · {PROJECT_FACTS.files} files ·{' '}
          {Math.round(PROJECT_FACTS.lines / 1000)}k lines · {PROJECT_FACTS.from} → {PROJECT_FACTS.to}
        </Text>
      </Box>

      {/* ---- sky ---- */}
      <Box flexDirection="column" marginTop={1}>
        {sky.map((row, index) => (
          <Text key={`sky-${index}`} color={index === 0 ? UI.dim : 'blueBright'} dimColor={index > 1}>
            {row}
          </Text>
        ))}
      </Box>

      {/* ---- the people ---- */}
      <Box flexDirection="column" marginTop={1} paddingX={2}>
        {CONTRIBUTORS.map((person, index) => {
          const share = person.commits / PROJECT_FACTS.commits;
          const arriving = typewriter(person.name, tick, 2, 2 + index * 6);
          return (
            <Box key={person.name} flexDirection="column" marginBottom={narrow ? 0 : 1}>
              <Box>
                <Text color={toneColor(index === 0 ? 'warning' : 'info')} bold>
                  {'  ● '}
                  {arriving}
                </Text>
                <Text color={UI.dim}>
                  {typewriterDone(person.name, tick, 2, 2 + index * 6)
                    ? `  ${person.commits} commits  ${progressBar(share * 100, 12)}`
                    : ''}
                </Text>
              </Box>
              {typewriterDone(person.name, tick, 2, 2 + index * 6) && (
                <>
                  {showRoles && (
                    <Text color={UI.dim} wrap="truncate-end">{`      ${person.role}`}</Text>
                  )}
                  {showNotes && person.note && (
                    <Text color={UI.dim} dimColor wrap="truncate-end">{`      ${person.note}`}</Text>
                  )}
                </>
              )}
            </Box>
          );
        })}
      </Box>

      {/* ---- the dedication ---- */}
      <Box
        flexDirection="column"
        paddingX={2}
        borderStyle="round"
        borderColor={frameColor}
      >
        <Text color={UI.accent} bold>
          {'✳  '}
          {THANKS_TITLE}
        </Text>
        <Box flexDirection="column">
          {thanks.map((line, index) => (
            <Text
              key={`thanks-${index}`}
              color={index === 0 ? 'whiteBright' : UI.dim}
              wrap="truncate-end"
            >
              {typewriter(line, tick, 3, starts[index] ?? 0) || ' '}
            </Text>
          ))}
        </Box>
      </Box>

      {/* Safe now that the rows above are budgeted: it only takes up slack. */}
      <Box flexGrow={1} />
      <KeyHints
        hints={[
          { key: 'space', label: running ? 'pause' : 'play' },
          { key: 'r', label: 'replay' },
          { key: '1-7', label: 'back to work' },
        ]}
      />
    </Box>
  );
}
