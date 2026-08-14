import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { client } from './api';
import { Layout } from './components/layout';
import { Loading } from './components/ui';
import { ActivityPage } from './pages/activity';
import { AgentDetailPage } from './pages/agent-detail';
import { AgentsPage } from './pages/agents';
import { DashboardPage } from './pages/dashboard';
import { MessagesPage } from './pages/messages';
import { OnboardingPage } from './pages/onboarding';
import { RunDetailPage } from './pages/run-detail';
import { RunsPage } from './pages/runs';
import { SettingsPage } from './pages/settings';
import { TeamDetailPage } from './pages/team-detail';
import { TeamsPage } from './pages/teams';

/**
 * Routing. `/` resolves to the dashboard, or to the first-run wizard while
 * onboarding is still needed — the core decides which, not this component.
 */
export function App() {
  const location = useLocation();
  const [onboardingNeeded, setOnboardingNeeded] = useState<boolean | undefined>();

  useEffect(() => {
    void client
      .getOnboardingStatus()
      .then((status) => setOnboardingNeeded(status.needed))
      .catch(() => setOnboardingNeeded(false));
  }, []);

  if (onboardingNeeded === undefined) return <Loading label="Checking your setup…" />;

  const wantsOnboarding = location.pathname === '/onboarding';

  return (
    <Routes>
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route element={<Layout />}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/teams" element={<TeamsPage />} />
        <Route path="/teams/:teamId" element={<TeamDetailPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/agents/:agentId" element={<AgentDetailPage />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:runId" element={<RunDetailPage />} />
        <Route path="/messages" element={<MessagesPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route
        path="*"
        element={
          <Navigate to={onboardingNeeded && !wantsOnboarding ? '/onboarding' : '/dashboard'} replace />
        }
      />
    </Routes>
  );
}
