import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import type { SearchHit } from '@claude-team/core';
import {
  COMMANDS,
  KEY_LEGEND,
  SECTIONS,
  availableCommands,
  filterCommands,
  truncate,
} from '@claude-team/ui-shared';
import { toneColor, UI } from '../theme.js';
import { errorMessage, useKeys, useRawMode, windowOf } from '../lib/hooks.js';
import { useUi } from '../store.js';
import { executeCommand } from '../actions.js';
import { Dim, KeyHints, ListRow, MoreRow } from './ui.js';

const OVERLAY_HEIGHT = 10;

export function OverlayHost(): React.JSX.Element | null {
  const ui = useUi();
  if (ui.overlay === 'palette') return <CommandPalette />;
  if (ui.overlay === 'search') return <SearchOverlay />;
  if (ui.overlay === 'help') return <HelpOverlay />;
  return null;
}

function Frame({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={UI.accent} paddingX={1} flexShrink={0}>
      <Text bold color={UI.accent}>
        {title}
      </Text>
      {children}
    </Box>
  );
}

/* ------------------------------------------------------------------ *
 * Command palette
 * ------------------------------------------------------------------ */

function CommandPalette(): React.JSX.Element {
  const ui = useUi();
  const [query, setQuery] = useState('');
  const active = ui.lock === 'overlay';
  const typing = useRawMode();

  const commands = filterCommands(
    availableCommands({
      team: Boolean(ui.selection.teamId),
      agent: Boolean(ui.selection.agentId),
      run: Boolean(ui.selection.runId),
    }),
    query,
  );

  const [index, setIndex] = useState(0);
  const cursor = Math.min(index, Math.max(0, commands.length - 1));

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useKeys(
    (_input, key) => {
      if (key.escape) {
        ui.setOverlay(null);
        return;
      }
      if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow) setIndex((i) => Math.min(commands.length - 1, i + 1));
      else if (key.return) {
        const command = commands[cursor];
        ui.setOverlay(null);
        if (command) void executeCommand(command.id, ui);
      }
    },
    active,
  );

  const { slice, offset } = windowOf(commands, cursor, OVERLAY_HEIGHT);

  return (
    <Frame title={`Command palette  ${COMMANDS.length} commands`}>
      <Box>
        <Text color={UI.accent}>› </Text>
        <TextInput value={query} onChange={setQuery} placeholder="type to filter…" focus={active && typing} />
      </Box>
      {commands.length === 0 ? <Dim>Nothing matches "{query}".</Dim> : null}
      {slice.map((command, i) => {
        const selected = offset + i === cursor;
        return (
          <ListRow key={command.id} selected={selected} focused>
            <Box>
              <Box width={11} flexShrink={0}>
                <Text color={UI.dim}>{command.group}</Text>
              </Box>
              <Box flexGrow={1}>
                <Text
                  color={command.destructive ? toneColor('danger') : selected ? UI.accent : undefined}
                  wrap="truncate-end"
                >
                  {command.title}
                  {command.hint ? <Text color={UI.dim}>{`  ${command.hint}`}</Text> : null}
                </Text>
              </Box>
              {command.key ? <Text color={UI.dim}>{` [${command.key}]`}</Text> : null}
            </Box>
          </ListRow>
        );
      })}
      <MoreRow count={commands.length - slice.length - offset} />
      <KeyHints
        hints={[
          { key: '↑↓', label: 'move' },
          { key: '↵', label: 'run' },
          { key: 'esc', label: 'close' },
        ]}
      />
    </Frame>
  );
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  team: 'team',
  agent: 'agent',
  run: 'run',
  task: 'task',
  message: 'msg',
};

function SearchOverlay(): React.JSX.Element {
  const ui = useUi();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [index, setIndex] = useState(0);
  const active = ui.lock === 'overlay';
  const typing = useRawMode();

  // Debounced so a fast typist does not fan out a query per keystroke.
  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      ui.core
        .search(query, 40)
        .then((results) => {
          if (cancelled) return;
          setHits(results);
          setError(undefined);
          setIndex(0);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(errorMessage(err));
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, ui.core]);

  const open = (hit: SearchHit) => {
    ui.setOverlay(null);
    ui.select({ teamId: hit.teamId, agentId: hit.agentId, runId: hit.runId });
    switch (hit.kind) {
      case 'team':
        ui.setSection('teams');
        break;
      case 'agent':
        ui.setSection('agents');
        break;
      case 'run':
      case 'task':
        ui.setSection('runs');
        break;
      case 'message':
        ui.setSection('messages');
        break;
    }
  };

  useKeys(
    (_input, key) => {
      if (key.escape) ui.setOverlay(null);
      else if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow) setIndex((i) => Math.min(hits.length - 1, i + 1));
      else if (key.return && hits[index]) open(hits[index]);
    },
    active,
  );

  const { slice, offset } = windowOf(hits, index, OVERLAY_HEIGHT);

  return (
    <Frame title="Search">
      <Box>
        <Text color={UI.accent}>/ </Text>
        <TextInput
          value={query}
          onChange={setQuery}
          placeholder="teams, agents, runs, tasks, messages…"
          focus={active && typing}
        />
      </Box>
      {error ? <Text color={toneColor('danger')}>{error}</Text> : null}
      {!error && query.trim() && hits.length === 0 ? <Dim>No matches.</Dim> : null}
      {slice.map((hit, i) => {
        const selected = offset + i === index;
        return (
          <ListRow key={`${hit.kind}-${hit.id}`} selected={selected} focused>
            <Box>
              <Box width={7} flexShrink={0}>
                <Text color={UI.dim}>{KIND_LABEL[hit.kind]}</Text>
              </Box>
              <Box flexGrow={1}>
                <Text wrap="truncate-end" color={selected ? UI.accent : undefined}>
                  {truncate(hit.title, 44)}
                  <Text color={UI.dim}>{`  ${truncate(hit.subtitle, 40)}`}</Text>
                </Text>
              </Box>
            </Box>
          </ListRow>
        );
      })}
      <MoreRow count={hits.length - slice.length - offset} />
      <KeyHints hints={[{ key: '↵', label: 'go to' }, { key: 'esc', label: 'close' }]} />
    </Frame>
  );
}

/* ------------------------------------------------------------------ *
 * Help
 * ------------------------------------------------------------------ */

function HelpOverlay(): React.JSX.Element {
  const ui = useUi();
  useKeys(() => ui.setOverlay(null), ui.lock === 'overlay');

  const groups = new Map<string, string[]>();
  for (const command of COMMANDS) {
    if (!command.key) continue;
    const list = groups.get(command.group) ?? [];
    list.push(`${command.key.padEnd(6)} ${command.title}`);
    groups.set(command.group, list);
  }

  return (
    <Frame title="Help">
      <Box>
        <Box width={26} flexDirection="column">
          <Text bold>Sections</Text>
          {SECTIONS.map((section) => (
            <Text key={section.id} color={UI.dim}>
              {section.key.padEnd(6)} {section.label}
            </Text>
          ))}
          <Text bold>Panels</Text>
          <Text color={UI.dim}>tab{'    '}switch panel</Text>
          <Text color={UI.dim}>↑↓ jk{' '} move</Text>
          <Text color={UI.dim}>esc{'    '}close / back</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {[...groups.entries()].map(([group, lines]) => (
            <Box key={group} flexDirection="column">
              <Text bold>{group}</Text>
              {lines.map((line) => (
                <Text key={line} color={UI.dim}>
                  {line}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      </Box>
      <Box marginTop={1}>
        <KeyHints hints={KEY_LEGEND} />
      </Box>
      <Dim>Press any key to close.</Dim>
    </Frame>
  );
}
