import React from 'react';
import { Box, Text } from 'ink';
import { formatClock, truncate } from '@claude-team/ui-shared';
import { toneColor, UI } from '../theme.js';
import { useKeys } from '../lib/hooks.js';
import { useUi } from '../store.js';
import { Dim, Field } from './ui.js';

/**
 * Human-in-the-loop gate. An agent is blocked while this is on screen, so it
 * interrupts whatever view is showing and owns the keyboard until answered.
 */
export function ApprovalModal(): React.JSX.Element | null {
  const ui = useUi();
  const approval = ui.approvals[0];
  const active = ui.lock === 'approval';

  useKeys(
    (input) => {
      if (!approval) return;
      if (input === 'y') ui.decideApproval(approval.id, 'allow_once');
      else if (input === 'a') ui.decideApproval(approval.id, 'allow_always');
      else if (input === 'n') ui.decideApproval(approval.id, 'deny');
    },
    active && Boolean(approval),
  );

  if (!approval) return null;

  const inputPreview = Object.entries(approval.input ?? {})
    .map(([key, value]) => `${key}=${truncate(typeof value === 'string' ? value : JSON.stringify(value), 60)}`)
    .slice(0, 4);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={toneColor('warning')}
      paddingX={1}
      flexShrink={0}
    >
      <Text bold color={toneColor('warning')}>
        ⚠ Approval required{ui.approvals.length > 1 ? ` (${ui.approvals.length} waiting)` : ''}
      </Text>
      <Text wrap="truncate-end">{approval.summary}</Text>
      <Field label="tool" value={`${approval.toolName}  (${approval.category})`} />
      <Field label="agent" value={approval.agentId} />
      <Field label="run" value={approval.runId} />
      <Field label="requested" value={formatClock(approval.createdAt)} />
      {inputPreview.map((line) => (
        <Box key={line} paddingLeft={2}>
          <Dim>{line}</Dim>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text>
          <Text color={toneColor('success')}>[y]</Text> allow once{'  '}
          <Text color={toneColor('warning')}>[a]</Text> always for this run{'  '}
          <Text color={toneColor('danger')}>[n]</Text> deny
        </Text>
      </Box>
      <Text color={UI.dim}>The agent stays blocked until you answer.</Text>
    </Box>
  );
}
