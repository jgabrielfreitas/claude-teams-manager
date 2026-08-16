import { COMMANDS, availableCommands, type CommandDefinition } from '@claude-team/ui-shared';

/**
 * Commands that only exist in the terminal.
 *
 * The shared catalogue in `@claude-team/ui-shared` is what both surfaces agree
 * on; a full-screen terminal view and a copy to the system clipboard have no
 * counterpart in the browser, so they are declared here instead of being forced
 * into a list the web would then have to hide.
 *
 * Everything else — the shape of a command, the availability rule, the grouping
 * and the way the palette filters — still comes from the shared module.
 */
export const TUI_ONLY_COMMANDS: CommandDefinition[] = [
  {
    id: 'run.fullscreen',
    title: 'Open Run Full Screen',
    hint: 'the whole terminal, one run',
    group: 'Run',
    requires: 'run',
    key: 'f',
    keywords: ['maximise', 'maximize', 'expand', 'timeline', 'zoom'],
  },
  {
    id: 'run.copyTranscript',
    title: 'Copy Run Transcript',
    hint: 'to the system clipboard',
    group: 'Run',
    requires: 'run',
    key: 'y',
    keywords: ['clipboard', 'yank', 'export', 'markdown'],
  },
  {
    id: 'run.exportTranscript',
    title: 'Export Run Transcript',
    hint: 'to a file',
    group: 'Run',
    requires: 'run',
    key: 'e',
    keywords: ['save', 'download', 'file', 'markdown', 'json'],
  },
  {
    // Not scoped to the selected run: whichever agent is blocked, the prompt
    // has to be reachable — including from a section that has no run selected.
    id: 'question.open',
    title: 'Answer Pending Question',
    hint: 'reopen the prompt an agent is waiting on',
    group: 'Run',
    key: 'Q',
    keywords: ['question', 'ask', 'answer', 'prompt', 'blocked', 'waiting'],
  },
  {
    id: 'app.autoMode',
    title: 'Toggle Auto Mode',
    hint: 'approve everything and answer questions automatically',
    group: 'App',
    key: 'A',
    keywords: ['auto', 'unattended', 'automatic', 'approve', 'answer', 'dangerous'],
  },
];

const TUI_IDS = new Set(TUI_ONLY_COMMANDS.map((command) => command.id));

/** The shared catalogue with each terminal-only command next to its group. */
export const ALL_COMMANDS: CommandDefinition[] = (() => {
  const merged = [...COMMANDS];
  for (const command of TUI_ONLY_COMMANDS) {
    const last = merged.map((entry) => entry.group).lastIndexOf(command.group);
    if (last === -1) merged.push(command);
    else merged.splice(last + 1, 0, command);
  }
  return merged;
})();

/**
 * Commands offered for the current selection. The shared rule decides for the
 * shared commands; the terminal-only ones are filtered by the same `requires`
 * field, so one that needs nothing (answering a question, flipping auto mode)
 * is always offered.
 */
export function allAvailableCommands(context: {
  team?: boolean;
  agent?: boolean;
  run?: boolean;
}): CommandDefinition[] {
  const shared = new Set(availableCommands(context).map((command) => command.id));
  return ALL_COMMANDS.filter((command) => {
    if (!TUI_IDS.has(command.id)) return shared.has(command.id);
    switch (command.requires) {
      case 'team':
        return Boolean(context.team);
      case 'agent':
        return Boolean(context.agent);
      case 'run':
        return Boolean(context.run);
      default:
        return true;
    }
  });
}
