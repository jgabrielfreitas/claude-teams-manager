import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SECTIONS, availableCommands, filterCommands, type CommandDefinition } from '@claude-team/ui-shared';
import type { SearchHitDto } from '@claude-team/protocol';
import { client } from '../api';
import { useSelection } from '../state/selection';
import { useAction, useToasts } from '../state/toasts';

/**
 * The command palette (`⌘K` / `ctrl+K`).
 *
 * The list, the grouping and the availability rules come from
 * `@claude-team/ui-shared` — exactly the same catalogue the TUI shows. This
 * component only decides how each id is carried out in a browser.
 */

const SECTION_PATH = new Map<string, string>(
  SECTIONS.map((section) => [section.id, section.path]),
);

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const selection = useSelection();
  const act = useAction();
  const { notify } = useToasts();

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [hits, setHits] = useState<SearchHitDto[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo(
    () =>
      filterCommands(
        availableCommands({
          team: Boolean(selection.teamId),
          agent: Boolean(selection.agentId),
          run: Boolean(selection.runId),
        }),
        query,
      ),
    [selection.teamId, selection.agentId, selection.runId, query],
  );

  useEffect(() => {
    if (!open) {
      setQuery('');
      setHits([]);
      setCursor(0);
    }
  }, [open]);

  // Search runs against the core's search use case, never a local filter.
  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      void client
        .search(query.trim())
        .then((results) => setHits(results.slice(0, 8)))
        .catch(() => setHits([]));
    }, 180);
    return () => clearTimeout(timer);
  }, [open, query]);

  const go = useCallback(
    (path: string) => {
      onClose();
      navigate(path);
    },
    [navigate, onClose],
  );

  const runCommand = useCallback(
    async (command: CommandDefinition) => {
      const { teamId, agentId, runId } = selection;

      if (command.id.startsWith('nav.')) {
        const path = SECTION_PATH.get(command.id.slice('nav.'.length));
        if (path) go(path);
        return;
      }

      switch (command.id) {
        case 'team.create':
          return go('/teams?new=blank');
        case 'team.fromPreset':
          return go('/teams?new=preset');
        case 'team.import':
          return go('/teams?action=import');
        case 'team.edit':
          return go(`/teams/${teamId}?action=edit`);
        case 'team.export':
          return go(`/teams/${teamId}?action=export`);
        case 'team.setOrchestrator':
          return go(`/teams/${teamId}?action=orchestrator`);
        case 'team.delete':
          return go(`/teams/${teamId}?action=delete`);
        case 'team.duplicate': {
          onClose();
          await act(async () => {
            const copy = await client.duplicateTeam(teamId!);
            navigate(`/teams/${copy.id}`);
          }, 'Team duplicated');
          return;
        }

        case 'agent.create':
          return go(`/teams/${teamId}?new=agent`);
        case 'agent.fromTemplate':
          return go(`/teams/${teamId}?new=template`);
        case 'agent.edit':
          return go(`/agents/${agentId}?action=edit`);
        case 'agent.switchModel':
          return go(`/agents/${agentId}?action=model`);
        case 'agent.changeEffort':
          return go(`/agents/${agentId}?action=effort`);
        case 'agent.permissions':
          return go(`/agents/${agentId}?action=permissions`);
        case 'agent.communication':
          return go(`/agents/${agentId}?action=communication`);
        case 'agent.inspect':
          return go(`/agents/${agentId}`);
        case 'agent.message':
          return go(`/agents/${agentId}?action=message`);
        case 'agent.delete':
          return go(`/agents/${agentId}?action=delete`);
        case 'agent.duplicate': {
          onClose();
          await act(async () => {
            const copy = await client.duplicateAgent(agentId!);
            navigate(`/agents/${copy.id}`);
          }, 'Agent duplicated');
          return;
        }

        case 'run.start':
          return go(`/teams/${teamId}?action=run`);
        case 'run.logs':
          return go(`/runs/${runId}?tab=timeline`);
        case 'run.replay':
          return go(`/runs/${runId}?replay=1`);
        case 'run.pause':
          onClose();
          await act(() => client.pauseRun(runId!), 'Run paused');
          return;
        case 'run.resume':
          onClose();
          await act(() => client.resumeRun(runId!), 'Run resumed');
          return;
        case 'run.cancel':
          onClose();
          await act(() => client.cancelRun(runId!), 'Run cancelled');
          return;
        case 'run.retry': {
          onClose();
          await act(async () => {
            const retried = await client.retryRun(runId!);
            navigate(`/runs/${retried.id}`);
          }, 'Run restarted');
          return;
        }

        case 'app.search':
          setQuery('');
          return;
        case 'app.help':
          return go('/settings?tab=help');
        case 'app.onboarding':
          return go('/onboarding');
        case 'app.checkProvider': {
          onClose();
          await act(async () => {
            const health = await client.checkProvider();
            notify(health.detail, health.ok ? 'success' : 'danger');
          });
          return;
        }
        case 'app.quit':
          onClose();
          notify('Close this tab to leave. The server keeps running in your terminal.', 'info');
          return;
        default:
          onClose();
          notify(`"${command.title}" is not available here.`, 'warning');
      }
    },
    [act, go, navigate, notify, onClose, selection],
  );

  const openHit = useCallback(
    (hit: SearchHitDto) => {
      switch (hit.kind) {
        case 'team':
          return go(`/teams/${hit.id}`);
        case 'agent':
          return go(`/agents/${hit.id}`);
        case 'run':
          return go(`/runs/${hit.id}`);
        case 'task':
          return go(`/runs/${hit.runId}?tab=tasks&task=${hit.id}`);
        case 'message':
          return go(`/runs/${hit.runId}?tab=messages`);
        default:
          return undefined;
      }
    },
    [go],
  );

  const entries = useMemo(
    () => [
      ...hits.map((hit) => ({ kind: 'hit' as const, hit })),
      ...commands.map((command) => ({ kind: 'command' as const, command })),
    ],
    [hits, commands],
  );

  useEffect(() => setCursor(0), [query, hits.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open) return null;

  const activate = (index: number) => {
    const entry = entries[index];
    if (!entry) return;
    if (entry.kind === 'hit') openHit(entry.hit);
    else void runCommand(entry.command);
  };

  let lastGroup = '';

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          autoFocus
          value={query}
          placeholder="Search teams, agents, runs — or run a command…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setCursor((c) => Math.min(entries.length - 1, c + 1));
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              activate(cursor);
            }
          }}
        />

        <div className="palette-list" ref={listRef} role="listbox">
          {entries.length === 0 && <div className="empty small">Nothing matches “{query}”.</div>}

          {entries.map((entry, index) => {
            const group = entry.kind === 'hit' ? 'Results' : entry.command.group;
            const header = group !== lastGroup ? group : undefined;
            lastGroup = group;

            return (
              <div key={entry.kind === 'hit' ? `hit-${entry.hit.id}` : entry.command.id}>
                {header && <div className="palette-group">{header}</div>}
                <div
                  role="option"
                  aria-selected={index === cursor}
                  className="palette-item"
                  onMouseEnter={() => setCursor(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    activate(index);
                  }}
                >
                  {entry.kind === 'hit' ? (
                    <>
                      <span className="badge">{entry.hit.kind}</span>
                      <span className="truncate">{entry.hit.title}</span>
                      <span className="hint truncate">{entry.hit.subtitle}</span>
                    </>
                  ) : (
                    <>
                      <span className={entry.command.destructive ? 'tone-danger tone-text' : undefined}>
                        {entry.command.title}
                      </span>
                      {entry.command.hint && <span className="hint">{entry.command.hint}</span>}
                      {entry.command.key && (
                        <span className="kbd right">{entry.command.key}</span>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
