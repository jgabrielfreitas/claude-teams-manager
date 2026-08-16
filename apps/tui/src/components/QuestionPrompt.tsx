import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { AgentQuestion } from '@claude-team/domain';
import { formatDuration, formatRelative, truncate } from '@claude-team/ui-shared';
import { toneColor, UI } from '../theme.js';
import { useKeys, useListNav, useLoader, useTerminalSize, windowOf } from '../lib/hooks.js';
import { useUi } from '../store.js';
import { PromptInput } from './Dialogs.js';
import { Dim, KeyHints, ListRow, MoreRow } from './ui.js';

/**
 * An agent asking the human something it cannot decide alone.
 *
 * Deliberately not the approval modal, and deliberately nothing like it: an
 * approval answers "may I do this?" with yes/no, a question returns *content*
 * the agent then works from. The failure this exists to prevent is exactly the
 * confusion of the two — a question shown as "[y] once / [a] always / [n] deny"
 * lets the human grant a permission that never delivers an answer, and the
 * agent waits until the run is cancelled.
 *
 * So this one is blue rather than amber, is titled with the agent's own header,
 * lists the options as a choice rather than a verdict, and distinguishes
 * dismissing (the question stays pending) from answering.
 */
export function QuestionPrompt(): React.JSX.Element | null {
  const ui = useUi();
  const question = ui.activeQuestion;
  if (!question) return null;
  // Keyed on the question id so the cursor, the ticked boxes and any typed text
  // belong to one question and never leak into the next one in the queue.
  return <QuestionBody key={question.id} question={question} active={ui.lock === 'question'} />;
}

function QuestionBody({
  question,
  active,
}: {
  question: AgentQuestion;
  active: boolean;
}): React.JSX.Element {
  const ui = useUi();
  const size = useTerminalSize();
  const options = question.options;
  const hasOptions = options.length > 0;

  // With no options to pick from, typing is the only way to answer.
  const [typing, setTyping] = useState(!hasOptions);
  const [text, setText] = useState('');
  const [checked, setChecked] = useState<string[]>([]);

  const nav = useListNav(options.length, active && !typing);
  const agent = useLoader(() => ui.core.getAgent(question.agentId), [question.agentId]);
  const remainingMs = useRemaining(question.expiresAt);

  const submitSelection = (labels: string[]) => {
    ui.answerQuestion(question.id, { selected: labels });
  };

  const toggle = (label: string) => {
    setChecked((prev) => (prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]));
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    nav.setIndex(index);
    if (question.allowMultiple) toggle(option.label);
    else submitSelection([option.label]);
  };

  useKeys(
    (input, key) => {
      if (key.escape) {
        ui.dismissQuestion(question.id);
        return;
      }
      if (key.return) {
        // With nothing ticked, enter means "the option under the cursor".
        const cursor = options[nav.index]?.label;
        const labels = question.allowMultiple && checked.length > 0 ? checked : cursor ? [cursor] : [];
        submitSelection(labels);
        return;
      }
      if (input === ' ' && question.allowMultiple) {
        const cursor = options[nav.index]?.label;
        if (cursor) toggle(cursor);
        return;
      }
      if (input === 't' && question.allowFreeform) {
        setTyping(true);
        return;
      }
      if (input >= '1' && input <= '9') choose(Number(input) - 1);
    },
    active && !typing,
  );

  useKeys(
    (_input, key) => {
      if (!key.escape) return;
      // From the field, esc steps back to the options when there are any;
      // otherwise it dismisses, which never answers the question.
      if (hasOptions) setTyping(false);
      else ui.dismissQuestion(question.id);
    },
    active && typing,
  );

  const handle = agent.data ? `${agent.data.handle} · ${agent.data.role}` : question.agentId;
  const waiting = ui.questions.length;
  const optionRows = size.short ? 3 : Math.min(6, Math.max(2, size.rows - 12));
  const { slice, offset } = windowOf(options, nav.index, optionRows);
  const questionBudget = Math.max(24, (size.columns - 6) * (size.short ? 1 : 2));

  return (
    <Box
      flexDirection="column"
      borderStyle="bold"
      borderColor={toneColor('info')}
      paddingX={1}
      flexShrink={0}
    >
      <Text bold color={toneColor('info')} wrap="truncate-end">
        ? {question.header?.trim() || 'Question'}
        {waiting > 1 ? ` (${waiting} waiting)` : ''}
      </Text>
      <Text color={UI.dim} wrap="truncate-end">
        {handle} is asking · {formatRelative(question.createdAt)}
      </Text>
      <Box marginTop={size.short ? 0 : 1}>
        <Text>{truncate(question.question, questionBudget)}</Text>
      </Box>

      {hasOptions ? (
        <Box flexDirection="column" marginTop={size.short ? 0 : 1}>
          {slice.map((option, index) => {
            const position = offset + index;
            const isCursor = position === nav.index;
            const isChecked = checked.includes(option.label);
            const mark = question.allowMultiple ? `[${isChecked ? '×' : ' '}] ` : '';
            return (
              <ListRow key={option.label} selected={isCursor} focused>
                <Text
                  color={isChecked ? toneColor('success') : isCursor ? UI.accent : undefined}
                  wrap="truncate-end"
                >
                  <Text color={UI.dim}>{position < 9 ? `${position + 1} ` : '  '}</Text>
                  {mark}
                  {option.label}
                  {option.description ? (
                    <Text color={UI.dim}>{`  — ${truncate(option.description, 48)}`}</Text>
                  ) : null}
                </Text>
              </ListRow>
            );
          })}
          <MoreRow count={options.length - slice.length - offset} />
        </Box>
      ) : null}

      {typing ? (
        <Box flexDirection="column">
          <PromptInput
            value={text}
            onChange={setText}
            onSubmit={(submitted) =>
              ui.answerQuestion(question.id, {
                text: submitted,
                selected: checked.length > 0 ? checked : undefined,
              })
            }
            label="answer"
            placeholder="type your answer…"
            active={active}
          />
        </Box>
      ) : null}

      <Box marginTop={size.short ? 0 : 1}>
        <KeyHints
          hints={[
            ...(hasOptions && !typing
              ? [
                  { key: '↑↓', label: 'move' },
                  { key: '1-9', label: 'pick' },
                  ...(question.allowMultiple ? [{ key: 'space', label: 'toggle' }] : []),
                ]
              : []),
            { key: '↵', label: 'answer' },
            ...(question.allowFreeform && hasOptions && !typing ? [{ key: 't', label: 'type instead' }] : []),
            { key: 'esc', label: 'dismiss without answering' },
          ]}
        />
      </Box>
      <Text color={toneColor('warning')} wrap="truncate-end">
        The agent is blocked until you answer.
        {remainingMs !== undefined
          ? ` Answered automatically in ${formatDuration(remainingMs)} if you do not.`
          : ''}
      </Text>
      {size.short ? null : (
        <Dim>esc only hides this — the question stays pending and Q brings it back.</Dim>
      )}
    </Box>
  );
}

/** Milliseconds left before the core answers this question itself. */
function useRemaining(expiresAt: Date | string | undefined): number | undefined {
  const target = expiresAt ? new Date(expiresAt).getTime() : undefined;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (target === undefined || Number.isNaN(target)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [target]);

  if (target === undefined || Number.isNaN(target)) return undefined;
  return Math.max(0, target - now);
}
