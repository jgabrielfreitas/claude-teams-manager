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
import { MessagesView } from './views/Messages.js';
import { ActivityView } from './views/Activity.js';
import { SettingsView } from './views/Settings.js';
import { Onboarding } from './views/Onboarding.js';

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
      {size.short ? null : <Footer />}
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
