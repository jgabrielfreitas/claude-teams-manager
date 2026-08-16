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
];

const TUI_IDS = new Set(TUI_ONLY_COMMANDS.map((command) => command.id));

/** The shared catalogue with the terminal-only commands next to their group. */
export const ALL_COMMANDS: CommandDefinition[] = (() => {
  const lastRun = COMMANDS.map((command) => command.group).lastIndexOf('Run');
  if (lastRun === -1) return [...COMMANDS, ...TUI_ONLY_COMMANDS];
  return [...COMMANDS.slice(0, lastRun + 1), ...TUI_ONLY_COMMANDS, ...COMMANDS.slice(lastRun + 1)];
})();

/**
 * Commands offered for the current selection. The shared rule decides for the
 * shared commands; the terminal-only ones all need a run, which is the single
 * extra condition applied here.
 */
export function allAvailableCommands(context: {
  team?: boolean;
  agent?: boolean;
  run?: boolean;
}): CommandDefinition[] {
  const shared = new Set(availableCommands(context).map((command) => command.id));
  return ALL_COMMANDS.filter((command) =>
    TUI_IDS.has(command.id) ? Boolean(context.run) : shared.has(command.id),
  );
}
