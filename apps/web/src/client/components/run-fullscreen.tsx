import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RunDetailDto } from '@claude-team/protocol';
import { formatDuration, formatRelative, runDurationMs } from '@claude-team/ui-shared';
import { runStatusUi } from '../lib/tone';
import { RunExportControls, type ExportPrefs } from './run-export';
import { MessageThread, RunTotals, TaskBoard, TaskProgressSummary, Timeline } from './run-views';
import { Segmented, StatusPill } from './ui';

/**
 * The run, filling the window.
 *
 * Nothing is re-derived here: the same components the normal page uses are
 * given the whole viewport, and the data still arrives through the run
 * resource, which refreshes from the shared `EventSource` (never a poll).
 */

export type FullScreenTab = 'timeline' | 'tasks' | 'messages';

const TABS: Array<{ value: FullScreenTab; label: string }> = [
  { value: 'timeline', label: 'Timeline' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'messages', label: 'Messages' },
];

/** How close to the bottom still counts as "following". */
const STICK_THRESHOLD_PX = 32;

export function FullScreenRun({
  data,
  tab,
  onTabChange,
  onExit,
  prefs,
  onPrefsChange,
}: {
  data: RunDetailDto;
  tab: FullScreenTab;
  onTabChange: (tab: FullScreenTab) => void;
  onExit: () => void;
  prefs: ExportPrefs;
  onPrefsChange: (patch: Partial<ExportPrefs>) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(data.isActive);
  const ui = runStatusUi(data.run.status);

  // How many rows the chosen tab shows: the only thing that decides whether
  // "new content arrived" and the view should stick to the bottom.
  const count =
    tab === 'timeline'
      ? data.events.length
      : tab === 'messages'
        ? data.messages.length
        : data.tasks.length;

  // The page behind must not scroll while the overlay owns the viewport.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !follow) return;
    element.scrollTop = element.scrollHeight;
  }, [count, tab, follow]);

  // Only the user's own scrolling changes the mode: a programmatic jump lands
  // at the bottom, which re-reads as "following", so the two never fight.
  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setFollow(distance <= STICK_THRESHOLD_PX);
  };

  const jumpToLatest = () => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
    setFollow(true);
  };

  return createPortal(
    <section className="fullscreen" role="region" aria-label="Run, full screen">
      <header className="fullscreen-head">
        <div className="fullscreen-title">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onExit}>
            ✕ Exit
          </button>
          <h1 className="truncate" title={data.run.objective}>
            {data.run.objective}
          </h1>
          <StatusPill status={ui} />
          {data.isActive && <span className="tiny muted nowrap">live</span>}
          <span className="tiny muted nowrap">
            {data.run.startedAt
              ? formatDuration(runDurationMs(data.run))
              : formatRelative(data.run.createdAt)}
          </span>
          <span className="fullscreen-progress">
            <TaskProgressSummary progress={data.progress} />
          </span>
        </div>

        <div className="fullscreen-bar">
          <Segmented value={tab} options={TABS} onChange={onTabChange} />
          <span className="fullscreen-totals">
            <RunTotals totals={data.run.totals} />
          </span>
          <RunExportControls
            runId={data.run.id}
            prefs={prefs}
            onPrefsChange={onPrefsChange}
            compact
          />
        </div>
      </header>

      <div className="fullscreen-body" ref={scroller} onScroll={onScroll} tabIndex={-1}>
        {tab === 'timeline' && <Timeline events={data.events} agents={data.agents} />}
        {tab === 'tasks' && <TaskBoard tasks={data.tasks} agents={data.agents} />}
        {tab === 'messages' && <MessageThread messages={data.messages} agents={data.agents} />}
      </div>

      {!follow && count > 0 && (
        <button type="button" className="btn btn-primary jump-latest" onClick={jumpToLatest}>
          ↓ Jump to latest
        </button>
      )}
    </section>,
    document.body,
  );
}
