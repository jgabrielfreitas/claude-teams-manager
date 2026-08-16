import { spawn, type ChildProcess } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Putting text on the system clipboard from a terminal application.
 *
 * There is no portable API for this, so we try the platform's own helper first
 * and fall back to an OSC 52 escape sequence — which the *terminal emulator*
 * acts on, and therefore works over SSH, where `pbcopy` would target the remote
 * machine's clipboard rather than the one in front of the user.
 *
 * Nothing here ever throws: a clipboard failure is a status line, not a crash.
 */

export type ClipboardVia = 'pbcopy' | 'wl-copy' | 'xclip' | 'clip' | 'osc52';

export interface ClipboardResult {
  ok: boolean;
  /** Which mechanism accepted the text. */
  via?: ClipboardVia;
  /** Why it failed, or a caveat worth showing when it succeeded. */
  detail?: string;
}

interface Candidate {
  via: ClipboardVia;
  command: string;
  args: string[];
}

/** How long a clipboard helper may take before we give up on it. */
const COMMAND_TIMEOUT_MS = 5_000;

/**
 * Terminals cap the length of an OSC 52 sequence; xterm's default limit is the
 * lowest in common use. Past it the copy silently does nothing, so we say so
 * rather than claim a success we cannot verify.
 */
const OSC52_SAFE_BYTES = 74_994;

function commandsFor(os: string): Candidate[] {
  switch (os) {
    case 'darwin':
      return [{ via: 'pbcopy', command: 'pbcopy', args: [] }];
    case 'win32':
      return [{ via: 'clip', command: 'clip', args: [] }];
    default:
      // Wayland first: on a Wayland session xclip either fails or writes to a
      // clipboard nothing is reading.
      return [
        { via: 'wl-copy', command: 'wl-copy', args: [] },
        { via: 'xclip', command: 'xclip', args: ['-selection', 'clipboard'] },
      ];
  }
}

function reason(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
    return 'not installed';
  }
  return err instanceof Error ? err.message : String(err);
}

/** Feeds `text` to a helper on stdin. Resolves — never rejects. */
function pipeInto(candidate: Candidate, text: string): Promise<ClipboardResult> {
  return new Promise((resolve) => {
    let handle: ChildProcess;
    try {
      handle = spawn(candidate.command, candidate.args, {
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
        // `clip` is a .exe resolved through PATHEXT, which only the shell does.
        shell: platform() === 'win32',
      });
    } catch (err) {
      resolve({ ok: false, detail: `${candidate.command}: ${reason(err)}` });
      return;
    }

    let settled = false;
    const done = (result: ClipboardResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // A helper that never reads its stdin must not hold the interface.
    const timer = setTimeout(() => {
      handle.kill();
      done({ ok: false, detail: `${candidate.command}: timed out` });
    }, COMMAND_TIMEOUT_MS);

    let stderr = '';
    handle.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });
    handle.on('error', (err) => done({ ok: false, detail: `${candidate.command}: ${reason(err)}` }));
    handle.on('close', (code) =>
      done(
        code === 0
          ? { ok: true, via: candidate.via }
          : { ok: false, detail: `${candidate.command}: ${stderr.trim() || `exited with ${code}`}` },
      ),
    );

    // A helper that dies before reading gives us EPIPE here; the 'error' and
    // 'close' handlers above already describe that, so this must stay silent.
    handle.stdin?.on('error', () => undefined);
    try {
      handle.stdin?.end(text);
    } catch (err) {
      done({ ok: false, detail: `${candidate.command}: ${reason(err)}` });
    }
  });
}

/**
 * The escape sequence the terminal itself understands. This is the path that
 * works over SSH and inside containers, where no clipboard binary exists.
 */
function viaOsc52(text: string): ClipboardResult {
  const stream = process.stdout;
  if (!stream.isTTY) return { ok: false, detail: 'OSC 52: not a terminal' };

  const payload = Buffer.from(text, 'utf8').toString('base64');
  const sequence = `\u001B]52;c;${payload}\u0007`;
  // tmux drops a sequence it does not understand unless it is wrapped in a
  // passthrough, inside which the leading ESC has to be doubled.
  const wrapped = process.env.TMUX ? `\u001BPtmux;\u001B${sequence}\u001B\\` : sequence;

  try {
    stream.write(wrapped);
  } catch (err) {
    return { ok: false, detail: `OSC 52: ${reason(err)}` };
  }

  return {
    ok: true,
    via: 'osc52',
    detail:
      payload.length > OSC52_SAFE_BYTES
        ? 'sent as an OSC 52 escape — some terminals drop one this large'
        : undefined,
  };
}

/**
 * Copies `text` to the system clipboard, trying the platform helper first and
 * OSC 52 second. Returns what happened instead of throwing, so the caller can
 * put either a confirmation or an explanation on the status line.
 */
export async function copyToClipboard(text: string): Promise<ClipboardResult> {
  const failures: string[] = [];

  for (const candidate of commandsFor(platform())) {
    try {
      const result = await pipeInto(candidate, text);
      if (result.ok) return result;
      if (result.detail) failures.push(result.detail);
    } catch (err) {
      failures.push(`${candidate.command}: ${reason(err)}`);
    }
  }

  try {
    const escaped = viaOsc52(text);
    if (escaped.ok) return escaped;
    if (escaped.detail) failures.push(escaped.detail);
  } catch (err) {
    failures.push(`OSC 52: ${reason(err)}`);
  }

  return { ok: false, detail: failures.join('; ') || 'no clipboard mechanism available' };
}
