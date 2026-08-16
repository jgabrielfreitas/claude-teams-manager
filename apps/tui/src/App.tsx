import React from 'react';
import { Box, Text } from 'ink';
import { SECTIONS } from '@claude-team/ui-shared';
import { toneColor, UI } from './theme.js';
import { useKeys, useTerminalSize } from './lib/hooks.js';
import { useUi } from './store.js';
import { ApprovalModal } from './components/ApprovalModal.js';
import { DialogHost } from './components/Dialogs.js';
import { OverlayHost } from './components/Overlays.js';
import { Footer, Header, StatusBar } from './components/Layout.js';
import { DashboardView } from './views/Dashboard.js';
import { TeamsView } from './views/Teams.js';
import { AgentsView } from './views/Agents.js';
import { RunsView } from './views/Runs.js';
import { RunFullScreen } from './views/RunFullScreen.js';
import { MessagesView } from './views/Messages.js';
import { ActivityView } from './views/Activity.js';
import { SettingsView } from './views/Settings.js';
import { Onboarding } from './views/Onboarding.js';

/**
 * Keys the Runs section adds to the shared legend. They are listed here rather
 * than in `KEY_LEGEND` because they are terminal-only: neither the full-screen
 * view nor the system clipboard exists in the browser.
 */
const RUN_KEYS = [
  { key: 'f', label: 'full screen' },
  { key: 'y', label: 'copy transcript' },
  { key: 'e', label: 'export transcript' },
];

/** The shell: chrome, global keys, and whichever section is on screen. */
export function App(): React.JSX.Element {
  const ui = useUi();
  const size = useTerminalSize();

  useKeys(
    (input, key) => {
      if (key.ctrl && input === 'k') {
        ui.setOverlay('palette');
        return;
      }
      if (input === '/') {
        ui.setOverlay('search');
        return;
      }
      if (input === '?') {
        ui.setOverlay('help');
        return;
      }
      // The full-screen run view owns everything else while it is up: `q` and
      // `esc` must take the user back to the run list, not out of the app, and
      // it binds letters (g, G, f, t) that mean something different here.
      if (ui.runFullScreen) return;
      if (input === 'q') {
        ui.quit();
        return;
      }
      if (key.tab) {
        ui.toggleFocus();
        return;
      }
      if (key.escape) {
        if (ui.focus === 'detail') ui.setFocus('list');
        return;
      }
      const section = SECTIONS.find((candidate) => candidate.key === input);
      if (section) ui.setSection(section.id);
    },
    ui.lock === 'view' && !ui.onboarding,
  );

  const chrome = (ui.status ? 1 : 0) + (size.short ? 1 : 2);
  const bodyHeight = Math.max(4, size.rows - chrome - 1);

  // The full-screen run view replaces the whole shell — no header, no footer,
  // no panels. Only the layers that must always be reachable stay: an approval
  // blocks an agent, a dialog is what the export prompt is made of, and the
  // status line is where a copy reports itself.
  if (ui.runFullScreen && !ui.onboarding) {
    return (
      <Box flexDirection="column" width={size.columns} height={Math.max(6, size.rows - 1)}>
        <Box flexDirection="column" flexGrow={1}>
          <ErrorBoundary>
            <RunFullScreen
              height={Math.max(4, size.rows - 1 - (ui.status ? 1 : 0))}
              columns={size.columns}
              narrow={size.narrow}
            />
          </ErrorBoundary>
        </Box>
        <OverlayHost />
        <DialogHost />
        <ApprovalModal />
        <StatusBar />
      </Box>
    );
  }

  const view = (() => {
    const props = { height: bodyHeight, columns: size.columns, narrow: size.narrow };
    switch (ui.section) {
      case 'dashboard':
        return <DashboardView {...props} />;
      case 'teams':
        return <TeamsView {...props} />;
      case 'agents':
        return <AgentsView {...props} />;
      case 'runs':
        return <RunsView {...props} />;
      case 'messages':
        return <MessagesView {...props} />;
      case 'activity':
        return <ActivityView {...props} />;
      case 'settings':
        return <SettingsView {...props} />;
      default:
        return <Text>Unknown section</Text>;
    }
  })();

  return (
    <Box flexDirection="column" width={size.columns} height={Math.max(10, size.rows - 1)}>
      {size.short ? null : <Header columns={size.columns} />}
      <Box flexDirection="column" flexGrow={1}>
        <ErrorBoundary>
          {ui.onboarding ? <Onboarding columns={size.columns} height={bodyHeight} /> : view}
        </ErrorBoundary>
      </Box>
      <OverlayHost />
      <DialogHost />
      <ApprovalModal />
      <StatusBar />
      {size.short ? null : <Footer extra={ui.section === 'runs' ? RUN_KEYS : undefined} />}
    </Box>
  );
}

/**
 * A rendering failure must not take the terminal down: it becomes a visible
 * message, and every other section stays usable.
 */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { message?: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = {};
  }

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidUpdate(prevProps: { children: React.ReactNode }): void {
    if (prevProps.children !== this.props.children && this.state.message) {
      this.setState({ message: undefined });
    }
  }

  override render(): React.ReactNode {
    if (this.state.message) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color={toneColor('danger')}>✗ This view failed to render: {this.state.message}</Text>
          <Text color={UI.dim}>Switch section (1–7) to carry on.</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
