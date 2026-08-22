/**
 * The command catalogue behind both command palettes.
 *
 * A command is declared once, with the context it needs; each surface decides
 * how to run it (the TUI calls the core directly, the web calls the API), but
 * the list, the names, the grouping and the availability rules are shared.
 */

export type CommandContext = 'global' | 'team' | 'agent' | 'run';

export interface CommandDefinition {
  id: string;
  title: string;
  /** Short hint shown next to the title. */
  hint?: string;
  group: 'Navigate' | 'Create' | 'Run' | 'Agent' | 'Team' | 'App';
  /** What must be selected for this command to be offered. */
  requires?: CommandContext;
  /** Keyboard shortcut in the TUI. */
  key?: string;
  /** Words that should also match this command when searching. */
  keywords?: string[];
  /** True when the command destroys something; surfaces confirm first. */
  destructive?: boolean;
  /** Surfaces this command exists on. Unmarked commands belong to both. */
  surfaces?: readonly Surface[];
}

export const COMMANDS: CommandDefinition[] = [
  // Navigation
  { id: 'nav.dashboard', title: 'Go to Dashboard', group: 'Navigate', key: '1', keywords: ['home'] },
  { id: 'nav.teams', title: 'Go to Teams', group: 'Navigate', key: '2' },
  { id: 'nav.agents', title: 'Go to Agents', group: 'Navigate', key: '3' },
  { id: 'nav.runs', title: 'Go to Runs', group: 'Navigate', key: '4' },
  { id: 'nav.messages', title: 'Go to Messages', group: 'Navigate', key: '5' },
  { id: 'nav.activity', title: 'Go to Activity', group: 'Navigate', key: '6' },
  { id: 'nav.settings', title: 'Go to Settings', group: 'Navigate', key: '7' },
  {
    id: 'nav.credits',
    title: 'Go to Credits',
    group: 'Navigate',
    key: '8',
    surfaces: ['tui'],
    keywords: ['contributors', 'thanks', 'about', 'easter egg'],
  },

  // Creation
  { id: 'team.create', title: 'Create Team', group: 'Create', key: 'c', keywords: ['new'] },
  { id: 'team.fromPreset', title: 'Create Team from Preset', group: 'Create', keywords: ['template'] },
  { id: 'agent.create', title: 'Create Agent', group: 'Create', requires: 'team', keywords: ['new'] },
  {
    id: 'agent.fromTemplate',
    title: 'Create Agent from Template',
    group: 'Create',
    requires: 'team',
  },

  // Team
  { id: 'team.edit', title: 'Edit Team', group: 'Team', requires: 'team', key: 'e' },
  { id: 'team.duplicate', title: 'Duplicate Team', group: 'Team', requires: 'team' },
  { id: 'team.export', title: 'Export Team as YAML', group: 'Team', requires: 'team' },
  { id: 'team.import', title: 'Import Team from YAML', group: 'Team' },
  {
    id: 'team.setOrchestrator',
    title: 'Select Orchestrator',
    group: 'Team',
    requires: 'team',
    keywords: ['lead'],
  },
  { id: 'team.delete', title: 'Delete Team', group: 'Team', requires: 'team', destructive: true },

  // Agent
  {
    id: 'agent.switchModel',
    title: 'Switch Model',
    hint: 'for the selected agent only',
    group: 'Agent',
    requires: 'agent',
    key: 'M',
    keywords: ['opus', 'sonnet', 'haiku'],
  },
  {
    id: 'agent.changeEffort',
    title: 'Change Effort',
    hint: 'for the selected agent only',
    group: 'Agent',
    requires: 'agent',
    key: 'E',
    keywords: ['reasoning', 'thinking'],
  },
  { id: 'agent.edit', title: 'Edit Agent', group: 'Agent', requires: 'agent', key: 'e' },
  { id: 'agent.permissions', title: 'Edit Agent Permissions', group: 'Agent', requires: 'agent' },
  {
    id: 'agent.communication',
    title: 'Edit Who This Agent Can Message',
    group: 'Agent',
    requires: 'agent',
  },
  { id: 'agent.duplicate', title: 'Duplicate Agent', group: 'Agent', requires: 'agent' },
  { id: 'agent.inspect', title: 'Inspect Agent', group: 'Agent', requires: 'agent', key: 'i' },
  { id: 'agent.message', title: 'Send Message to Agent', group: 'Agent', requires: 'agent', key: 'm' },
  { id: 'agent.delete', title: 'Delete Agent', group: 'Agent', requires: 'agent', destructive: true },

  // Runs
  { id: 'run.start', title: 'Start Run', group: 'Run', requires: 'team', key: 'r' },
  { id: 'run.pause', title: 'Pause Run', group: 'Run', requires: 'run', key: 'p' },
  { id: 'run.resume', title: 'Resume Run', group: 'Run', requires: 'run' },
  { id: 'run.cancel', title: 'Cancel Run', group: 'Run', requires: 'run', key: 'x' },
  { id: 'run.retry', title: 'Retry Run', group: 'Run', requires: 'run' },
  { id: 'run.conversation', title: 'Open Run Conversation', group: 'Run', requires: 'run' },
  { id: 'run.logs', title: 'Open Run Timeline', group: 'Run', requires: 'run', key: 'l' },
  { id: 'run.replay', title: 'Replay Run', group: 'Run', requires: 'run' },
  { id: 'run.budget', title: 'Change Run Budget', group: 'Run', requires: 'run', key: 'b' },
  { id: 'run.delete', title: 'Delete Run', group: 'Run', requires: 'run', key: 'd', destructive: true },

  // App
  { id: 'app.search', title: 'Search', group: 'App', key: '/' },
  { id: 'app.help', title: 'Help', group: 'App', key: '?' },
  { id: 'app.onboarding', title: 'Run Onboarding Again', group: 'App' },
  { id: 'app.checkProvider', title: 'Check Claude Connection', group: 'App' },
  { id: 'app.quit', title: 'Quit', group: 'App', key: 'q' },
];

export function availableCommands(context: {
  team?: boolean;
  agent?: boolean;
  run?: boolean;
  /**
   * Which surface is asking. A caller that does not say gets only the
   * commands that belong everywhere — the safe direction to fail, since the
   * alternative is a palette entry that does nothing when chosen.
   */
  surface?: Surface;
}): CommandDefinition[] {
  return COMMANDS.filter((command) => {
    if (command.surfaces && (!context.surface || !command.surfaces.includes(context.surface))) {
      return false;
    }
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

/** Fuzzy-ish filter used by both palettes. */
export function filterCommands(commands: CommandDefinition[], query: string): CommandDefinition[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands;
  const scored = commands
    .map((command) => {
      const haystack = [command.title, command.group, command.hint ?? '', ...(command.keywords ?? [])]
        .join(' ')
        .toLowerCase();
      const index = haystack.indexOf(needle);
      if (index === -1) return undefined;
      return { command, score: index === 0 ? 2 : 1 };
    })
    .filter(Boolean) as Array<{ command: CommandDefinition; score: number }>;
  return scored.sort((a, b) => b.score - a.score).map((s) => s.command);
}

/* ------------------------------------------------------------------ *
 * Navigation sections, shared by both surfaces
 * ------------------------------------------------------------------ */

export const SECTIONS = [
  { id: 'dashboard', label: 'Dashboard', path: '/dashboard', key: '1' },
  { id: 'teams', label: 'Teams', path: '/teams', key: '2' },
  { id: 'agents', label: 'Agents', path: '/agents', key: '3' },
  { id: 'runs', label: 'Runs', path: '/runs', key: '4' },
  { id: 'messages', label: 'Messages', path: '/messages', key: '5' },
  { id: 'activity', label: 'Activity', path: '/activity', key: '6' },
  { id: 'settings', label: 'Settings', path: '/settings', key: '7' },
  /**
   * Who made this. Terminal only — it is a credits screen with a starfield in
   * it, and the marker is here so the browser's sidebar does not gain a link
   * to a page that was never built.
   */
  { id: 'credits', label: 'Credits', path: '/credits', key: '8', surfaces: ['tui'] },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];
export type Surface = 'tui' | 'web';

/** Sections a given surface should show. Unmarked sections belong to both. */
export function sectionsFor(surface: Surface): Array<(typeof SECTIONS)[number]> {
  return SECTIONS.filter(
    (section) => !('surfaces' in section) || (section.surfaces as readonly string[]).includes(surface),
  );
}

/**
 * The TUI footer hint line, so the key legend never drifts from the bindings.
 *
 * Only keys that work in *every* section belong here. `d delete` used to, and
 * advertised a binding that four of the seven sections did not have — the
 * footer said the key existed and pressing it did nothing. Section-specific
 * keys are listed by the section itself.
 */
export const KEY_LEGEND: Array<{ key: string; label: string }> = [
  { key: '↑↓', label: 'navigate' },
  { key: '↵', label: 'select' },
  { key: 'tab', label: 'panel' },
  { key: 'c', label: 'create' },
  { key: 'e', label: 'edit' },
  { key: 'r', label: 'run' },
  { key: 'm', label: 'message' },
  { key: 'l', label: 'logs' },
  { key: '/', label: 'search' },
  { key: 'ctrl+k', label: 'palette' },
  { key: '?', label: 'help' },
  { key: 'q', label: 'quit' },
];
