import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { SECTIONS, formatRelative, type Tone } from '@claude-team/ui-shared';
import { ApprovalCenter } from '../state/approvals';
import { useRealtime, type ConnectionStatus } from '../state/realtime';
import { toneClass } from '../lib/tone';
import { CommandPalette } from './command-palette';

const CONNECTION_UI: Record<ConnectionStatus, { label: string; tone: Tone; busy: boolean }> = {
  connecting: { label: 'connecting', tone: 'info', busy: true },
  open: { label: 'live', tone: 'success', busy: false },
  reconnecting: { label: 'reconnecting', tone: 'warning', busy: true },
  offline: { label: 'offline', tone: 'danger', busy: false },
};

/** True when a key belongs to whatever the user is typing into. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
}

export function Layout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const realtime = useRealtime();

  const openPalette = useCallback(() => setPaletteOpen(true), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.key === '/' && !isTypingTarget(event.target) && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const connection = CONNECTION_UI[realtime.status];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">CT</span>
          <span className="brand-text col" style={{ gap: 0 }}>
            <span className="brand-name">Claude Team</span>
            <span className="brand-sub">multi-agent teams</span>
          </span>
        </div>

        <nav className="nav" aria-label="Sections">
          {SECTIONS.map((section) => (
            <NavLink
              key={section.id}
              to={section.path}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              {section.label}
              <span className="nav-key">{section.key}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button
            type="button"
            className={`conn ${toneClass(connection.tone)}`}
            onClick={realtime.reconnect}
            title={
              realtime.lastEventAt
                ? `Last event ${formatRelative(realtime.lastEventAt)} · ${realtime.eventCount} received`
                : 'Server-sent events'
            }
          >
            <span className={`dot${connection.busy ? ' busy' : ''}`} />
            <span className="conn-label">{connection.label}</span>
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button type="button" className="search" onClick={openPalette}>
            <span aria-hidden>⌕</span>
            <span className="truncate">Search or run a command</span>
            <span className="kbd right">⌘K</span>
          </button>
          <span className="spacer" />
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ApprovalCenter />
    </div>
  );
}
