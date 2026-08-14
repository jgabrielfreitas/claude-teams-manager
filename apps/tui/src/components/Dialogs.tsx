import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import {
  PERMISSION_MODES,
  permissionMode,
  type PermissionMode,
  type ToolPermission,
} from '@claude-team/domain';
import type { Tone } from '@claude-team/ui-shared';
import { toneColor, UI } from '../theme.js';
import { useKeys, useListNav, useRawMode, windowOf } from '../lib/hooks.js';
import { useUi, type DialogRequest } from '../store.js';
import { Dim, KeyHints, ListRow, MoreRow } from './ui.js';

/**
 * Modal prompts. Views never implement their own input handling: they `await`
 * one of these and then call the core with the answer.
 */
export function DialogHost(): React.JSX.Element | null {
  const ui = useUi();
  const request = ui.dialogQueue[ui.dialogQueue.length - 1];
  if (!request) return null;
  const active = ui.lock === 'dialog';
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={UI.accent}
      paddingX={1}
      flexShrink={0}
    >
      <Text bold color={UI.accent}>
        {request.title}
      </Text>
      <DialogBody request={request} active={active} onResolve={(v) => ui.resolveDialog(request.id, v)} />
    </Box>
  );
}

function DialogBody({
  request,
  active,
  onResolve,
}: {
  request: DialogRequest;
  active: boolean;
  onResolve: (value: unknown) => void;
}): React.JSX.Element {
  switch (request.kind) {
    case 'text':
      return <TextDialog key={request.id} request={request} active={active} onResolve={onResolve} />;
    case 'select':
      return <SelectDialog key={request.id} request={request} active={active} onResolve={onResolve} />;
    case 'multiselect':
      return <MultiSelectDialog key={request.id} request={request} active={active} onResolve={onResolve} />;
    case 'confirm':
      return <ConfirmDialog key={request.id} request={request} active={active} onResolve={onResolve} />;
    case 'permissions':
      return <PermissionsDialog key={request.id} request={request} active={active} onResolve={onResolve} />;
    case 'info':
      return <InfoDialog key={request.id} request={request} active={active} onResolve={onResolve} />;
    default:
      return <Text>Unsupported dialog</Text>;
  }
}

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

function TextDialog({
  request,
  active,
  onResolve,
}: {
  request: Extract<DialogRequest, { kind: 'text' }>;
  active: boolean;
  onResolve: (value: unknown) => void;
}): React.JSX.Element {
  const [value, setValue] = useState(request.initial ?? '');
  const typing = useRawMode();

  useKeys((_input, key) => {
    if (key.escape) onResolve(undefined);
  }, active);

  return (
    <Box flexDirection="column">
      {request.help ? <Dim>{request.help}</Dim> : null}
      <Box>
        <Text color={UI.accent}>{request.label ?? '›'} </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={(submitted) => onResolve(submitted)}
          placeholder={request.placeholder ?? ''}
          focus={active && typing}
        />
      </Box>
      <KeyHints hints={[{ key: '↵', label: 'confirm' }, { key: 'esc', label: 'cancel' }]} />
    </Box>
  );
}

/* ------------------------------------------------------------------ *
 * Select
 * ------------------------------------------------------------------ */

const DIALOG_LIST_HEIGHT = 9;

function SelectDialog({
  request,
  active,
  onResolve,
}: {
  request: Extract<DialogRequest, { kind: 'select' }>;
  active: boolean;
  onResolve: (value: unknown) => void;
}): React.JSX.Element {
  const nav = useListNav(request.items.length, active);
  useKeys(
    (_input, key) => {
      if (key.escape) onResolve(undefined);
      else if (key.return) onResolve(request.items[nav.index]?.value);
    },
    active,
  );

  const { slice, offset } = windowOf(request.items, nav.index, DIALOG_LIST_HEIGHT);

  return (
    <Box flexDirection="column">
      {request.help ? <Dim>{request.help}</Dim> : null}
      {request.items.length === 0 ? <Dim>Nothing to choose from.</Dim> : null}
      {slice.map((item, index) => {
        const selected = offset + index === nav.index;
        return (
          <ListRow key={item.value} selected={selected} focused>
            <Text
              color={item.tone ? toneColor(item.tone) : selected ? UI.accent : undefined}
              wrap="truncate-end"
            >
              {item.label}
              {item.hint ? <Text color={UI.dim}>{`  ${item.hint}`}</Text> : null}
            </Text>
          </ListRow>
        );
      })}
      <MoreRow count={request.items.length - slice.length - offset} />
      <KeyHints
        hints={[
          { key: '↑↓', label: 'move' },
          { key: '↵', label: 'select' },
          { key: 'esc', label: 'cancel' },
        ]}
      />
    </Box>
  );
}

/* ------------------------------------------------------------------ *
 * Multi-select
 * ------------------------------------------------------------------ */

function MultiSelectDialog({
  request,
  active,
  onResolve,
}: {
  request: Extract<DialogRequest, { kind: 'multiselect' }>;
  active: boolean;
  onResolve: (value: unknown) => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>(request.selected);
  const nav = useListNav(request.items.length, active);

  useKeys(
    (input, key) => {
      if (key.escape) onResolve(undefined);
      else if (key.return) onResolve(selected);
      else if (input === ' ') {
        const value = request.items[nav.index]?.value;
        if (!value) return;
        setSelected((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
      }
    },
    active,
  );

  const { slice, offset } = windowOf(request.items, nav.index, DIALOG_LIST_HEIGHT);

  return (
    <Box flexDirection="column">
      {request.help ? <Dim>{request.help}</Dim> : null}
      {slice.map((item, index) => {
        const isCursor = offset + index === nav.index;
        const checked = selected.includes(item.value);
        return (
          <ListRow key={item.value} selected={isCursor} focused>
            <Text color={checked ? toneColor('success') : undefined} wrap="truncate-end">
              [{checked ? '×' : ' '}] {item.label}
              {item.hint ? <Text color={UI.dim}>{`  ${item.hint}`}</Text> : null}
            </Text>
          </ListRow>
        );
      })}
      <MoreRow count={request.items.length - slice.length - offset} />
      <KeyHints
        hints={[
          { key: 'space', label: 'toggle' },
          { key: '↵', label: 'save' },
          { key: 'esc', label: 'cancel' },
        ]}
      />
    </Box>
  );
}

/* ------------------------------------------------------------------ *
 * Confirm
 * ------------------------------------------------------------------ */

function ConfirmDialog({
  request,
  active,
  onResolve,
}: {
  request: Extract<DialogRequest, { kind: 'confirm' }>;
  active: boolean;
  onResolve: (value: unknown) => void;
}): React.JSX.Element {
  useKeys(
    (input, key) => {
      if (key.escape || input === 'n' || input === 'N') onResolve(false);
      else if (input === 'y' || input === 'Y' || key.return) onResolve(true);
    },
    active,
  );

  return (
    <Box flexDirection="column">
      {request.message ? (
        <Text color={request.danger ? toneColor('danger') : undefined}>{request.message}</Text>
      ) : null}
      <KeyHints hints={[{ key: 'y', label: 'yes' }, { key: 'n', label: 'no' }]} />
    </Box>
  );
}

/* ------------------------------------------------------------------ *
 * Permissions
 * ------------------------------------------------------------------ */

const MODE_TONE: Record<PermissionMode, Tone> = {
  allow: 'success',
  ask: 'warning',
  deny: 'danger',
};

function PermissionsDialog({
  request,
  active,
  onResolve,
}: {
  request: Extract<DialogRequest, { kind: 'permissions' }>;
  active: boolean;
  onResolve: (value: unknown) => void;
}): React.JSX.Element {
  const [modes, setModes] = useState<Record<string, PermissionMode>>(() => {
    const initial: Record<string, PermissionMode> = {};
    for (const group of request.groups) {
      initial[group.id] = permissionMode(request.permissions, group.id);
    }
    return initial;
  });
  const nav = useListNav(request.groups.length, active);

  const cycle = (delta: number) => {
    const group = request.groups[nav.index];
    if (!group) return;
    setModes((prev) => {
      const current = PERMISSION_MODES.indexOf(prev[group.id] ?? group.defaultMode);
      const next = (current + delta + PERMISSION_MODES.length) % PERMISSION_MODES.length;
      return { ...prev, [group.id]: PERMISSION_MODES[next] };
    });
  };

  useKeys(
    (input, key) => {
      if (key.escape) onResolve(undefined);
      else if (key.return) {
        const result: ToolPermission[] = request.groups.map((group) => ({
          group: group.id,
          mode: modes[group.id] ?? group.defaultMode,
        }));
        onResolve(result);
      } else if (key.rightArrow || input === ' ' || input === 'l') cycle(1);
      else if (key.leftArrow || input === 'h') cycle(-1);
    },
    active,
  );

  const { slice, offset } = windowOf(request.groups, nav.index, DIALOG_LIST_HEIGHT);

  return (
    <Box flexDirection="column">
      <Dim>← → cycles allow / ask / deny. Sensitive capabilities are marked !.</Dim>
      {slice.map((group, index) => {
        const isCursor = offset + index === nav.index;
        const mode = modes[group.id] ?? group.defaultMode;
        return (
          <ListRow key={group.id} selected={isCursor} focused>
            <Box>
              <Box width={10} flexShrink={0}>
                <Text color={toneColor(MODE_TONE[mode])}>{mode.padEnd(6)}</Text>
              </Box>
              <Box width={22} flexShrink={0}>
                <Text wrap="truncate-end">
                  {group.sensitive ? <Text color={toneColor('warning')}>! </Text> : '  '}
                  {group.label}
                </Text>
              </Box>
              <Text color={UI.dim} wrap="truncate-end">
                {group.description}
              </Text>
            </Box>
          </ListRow>
        );
      })}
      <MoreRow count={request.groups.length - slice.length - offset} />
      <KeyHints hints={[{ key: '↵', label: 'save' }, { key: 'esc', label: 'cancel' }]} />
    </Box>
  );
}

/* ------------------------------------------------------------------ *
 * Info
 * ------------------------------------------------------------------ */

function InfoDialog({
  request,
  active,
  onResolve,
}: {
  request: Extract<DialogRequest, { kind: 'info' }>;
  active: boolean;
  onResolve: (value: unknown) => void;
}): React.JSX.Element {
  useKeys(() => onResolve(undefined), active);
  return (
    <Box flexDirection="column">
      {request.lines.map((line, index) => (
        <Text key={`${index}-${line}`} wrap="truncate-end">
          {line}
        </Text>
      ))}
      <KeyHints hints={[{ key: 'any key', label: 'close' }]} />
    </Box>
  );
}
