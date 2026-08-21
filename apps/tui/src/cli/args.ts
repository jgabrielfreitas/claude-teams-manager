/**
 * Argument parsing for the `claude-team` binary.
 *
 * Deliberately tiny and dependency-free: the CLI only needs a handful of flags,
 * and everything it does afterwards is a call into `AppCore`.
 */

export interface ParsedArgs {
  positional: string[];
  db?: string;
  provider?: string;
  team?: string;
  /** Transcript format for `run export`. Validated by the command itself. */
  format?: string;
  /** Destination file for `run export`; stdout when omitted. */
  out?: string;
  /**
   * Directory runs work in. Defaults to where the command was called, which is
   * the whole point: `claude-team` acts on the folder you are standing in.
   */
  workspace?: string;
  /** Include debug events in an exported transcript. */
  debug: boolean;
  help: boolean;
  version: boolean;
  errors: string[];
}

const VALUE_FLAGS: Record<
  string,
  keyof Pick<ParsedArgs, 'db' | 'provider' | 'team' | 'format' | 'out' | 'workspace'>
> = {
  '--db': 'db',
  '--provider': 'provider',
  '--team': 'team',
  '--format': 'format',
  '--out': 'out',
  '--workspace': 'workspace',
};

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    positional: [],
    debug: false,
    help: false,
    version: false,
    errors: [],
  };

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      result.help = true;
      continue;
    }
    if (token === '--version' || token === '-v' || token === '-V') {
      result.version = true;
      continue;
    }
    if (token === '--debug') {
      result.debug = true;
      continue;
    }

    const [flag, inlineValue] = token.startsWith('--') && token.includes('=')
      ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
      : [token, undefined];

    const key = VALUE_FLAGS[flag];
    if (key) {
      const value = inlineValue ?? argv[++index];
      if (value === undefined) {
        result.errors.push(`${flag} needs a value.`);
        continue;
      }
      result[key] = value;
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      result.errors.push(`Unknown option "${token}".`);
      continue;
    }

    result.positional.push(token);
  }

  return result;
}

export const HELP_TEXT = `claude-team — teams of Claude agents in your terminal

Usage
  claude-team                          open the full interface (runs setup on first use)
  claude-team run "<objective>"        start a run and watch it live
  claude-team run                      list recent runs
  claude-team run export <runId>       print the full transcript of a run
  claude-team team list                list teams
  claude-team team export <name|id>    print a team as YAML
  claude-team team import <file.yaml>  create a team from a YAML file
  claude-team agent list               list every agent across teams

Options
  --team <name|id>    team to use for "run"
  --format <fmt>      transcript format for "run export": markdown (default), text, json
  --debug             include debug events (thinking, tool traffic) in a transcript
  --out <path>        write "run export" to a file instead of stdout
  --workspace <path>  directory runs work in (default: the current directory)
  --db <path>         SQLite file to use (default: $CLAUDE_TEAM_HOME/claude-team.db)
  --provider <id>     override the configured provider (claude, fake)
  -h, --help          show this help
  -v, --version       show the version

Environment
  CLAUDE_TEAM_HOME    directory holding the database (default: ~/.claude-team)

Keys inside the interface
  1-7 sections   tab panel   c create   e edit   r run   m message
  l logs   i inspect   / search   ctrl+k command palette   ? help   q quit

Keys in the Teams and Agents sections
  d delete

Keys in the Runs section
  b budget   d delete run   f full screen   y copy transcript   e export transcript

Keys in the full-screen run view
  t switch tab   ↑↓ / PgUp PgDn scroll   g top   G end   f follow again
  F cycle format   D toggle debug events   y copy   e export   esc back
`;
