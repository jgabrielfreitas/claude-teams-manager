import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client } from '../api';
import { useToasts } from '../state/toasts';
import { Modal, Segmented } from './ui';

/**
 * Copying and downloading a run.
 *
 * Nothing here formats a transcript: the document comes from
 * `core.exportRun` through the API client, so what the browser copies is
 * byte-identical to what the TUI copies and to the file that is downloaded
 * (ADR-001).
 */

export type ExportFormat = 'markdown' | 'text' | 'json';

const FORMAT_OPTIONS: Array<{ value: ExportFormat; label: string; title: string }> = [
  { value: 'markdown', label: 'Markdown', title: 'Markdown — headings, tables and a fenced timeline' },
  { value: 'text', label: 'Text', title: 'Plain text — fixed-width, paste anywhere' },
  { value: 'json', label: 'JSON', title: 'JSON — the structured record of the run' },
];

export interface ExportPrefs {
  format: ExportFormat;
  includeDebug: boolean;
}

const STORAGE_KEY = 'claude-team.run-export';
const DEFAULT_PREFS: ExportPrefs = { format: 'markdown', includeDebug: false };

function readPrefs(): ExportPrefs {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<ExportPrefs>;
    const format = FORMAT_OPTIONS.some((o) => o.value === parsed.format)
      ? (parsed.format as ExportFormat)
      : DEFAULT_PREFS.format;
    return { format, includeDebug: parsed.includeDebug === true };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** The chosen format and debug switch, remembered for the browser session. */
export function useExportPrefs(): [ExportPrefs, (patch: Partial<ExportPrefs>) => void] {
  const [prefs, setPrefs] = useState<ExportPrefs>(readPrefs);

  const update = useCallback((patch: Partial<ExportPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // A blocked storage must not stop the export itself.
      }
      return next;
    });
  }, []);

  return [prefs, update];
}

function sizeLabel(content: string): string {
  const bytes = new TextEncoder().encode(content).length;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}

/**
 * Copy, download and preview for one run, sharing a single format choice.
 * `compact` is the density used inside the full-screen header.
 */
export function RunExportControls({
  runId,
  prefs,
  onPrefsChange,
  compact,
}: {
  runId: string;
  prefs: ExportPrefs;
  onPrefsChange: (patch: Partial<ExportPrefs>) => void;
  compact?: boolean;
}) {
  const { notify, fail } = useToasts();
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<string | undefined>();
  const [preview, setPreview] = useState(false);

  const options = useMemo(() => ({ format: prefs.format, includeDebug: prefs.includeDebug }), [
    prefs.format,
    prefs.includeDebug,
  ]);

  const copy = async () => {
    setBusy(true);
    try {
      const { content, format } = await client.exportRun(runId, options);
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(content);
        notify(`Copied ${sizeLabel(content)} of ${format}`, 'success');
      } catch {
        // Permissions, or a page served over plain HTTP: hand the text over
        // in a selected textarea and say why.
        setManual(content);
        notify(
          `Clipboard blocked by the browser — ${sizeLabel(content)} of ${format} selected for you to copy manually`,
          'warning',
        );
      }
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    window.location.assign(client.runDownloadUrl(runId, options));
  };

  const size = compact ? ' btn-sm' : '';

  return (
    <>
      <div className="export-controls">
        <Segmented
          value={prefs.format}
          options={FORMAT_OPTIONS}
          onChange={(format) => onPrefsChange({ format })}
        />
        <label className="checkbox" title="Include debug-level events (thinking and tool traffic)">
          <input
            type="checkbox"
            checked={prefs.includeDebug}
            onChange={(event) => onPrefsChange({ includeDebug: event.target.checked })}
          />
          <span className={compact ? 'tiny' : 'small'}>debug events</span>
        </label>
        <button
          type="button"
          className={`btn${size}`}
          disabled={busy}
          onClick={() => setPreview(true)}
        >
          Preview
        </button>
        <button type="button" className={`btn${size}`} disabled={busy} onClick={() => void copy()}>
          Copy
        </button>
        <button type="button" className={`btn${size}`} onClick={download}>
          Download
        </button>
      </div>

      {preview && (
        <TranscriptPreview runId={runId} prefs={prefs} onClose={() => setPreview(false)} />
      )}
      {manual !== undefined && (
        <ManualCopyDialog content={manual} onClose={() => setManual(undefined)} />
      )}
    </>
  );
}

/** Exactly the document that Copy and Download would produce, read-only. */
function TranscriptPreview({
  runId,
  prefs,
  onClose,
}: {
  runId: string;
  prefs: ExportPrefs;
  onClose: () => void;
}) {
  const [state, setState] = useState<{ content?: string; fileName?: string; error?: string }>({});

  useEffect(() => {
    let cancelled = false;
    void client
      .exportRun(runId, { format: prefs.format, includeDebug: prefs.includeDebug })
      .then((result) => {
        if (!cancelled) setState({ content: result.content, fileName: result.fileName });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [runId, prefs.format, prefs.includeDebug]);

  return (
    <Modal
      title={`Transcript preview — ${prefs.format}`}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="tiny muted right">
            {state.content ? `${state.fileName} · ${sizeLabel(state.content)}` : ''}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {state.error && <div className="error-box">{state.error}</div>}
      {!state.error && <pre className="transcript">{state.content ?? 'Rendering…'}</pre>}
    </Modal>
  );
}

/** Fallback when the clipboard API refuses: select the text and let the user copy. */
function ManualCopyDialog({ content, onClose }: { content: string; onClose: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const area = ref.current;
    if (!area) return;
    area.focus();
    area.select();
  }, []);

  return (
    <Modal
      title="Copy manually"
      onClose={onClose}
      wide
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="small muted">
        The browser would not write to the clipboard — that happens without a secure origin or
        when clipboard permission is denied. The transcript below is already selected: press
        ⌘C / Ctrl+C.
      </p>
      <textarea className="textarea transcript-area" readOnly ref={ref} value={content} />
    </Modal>
  );
}
