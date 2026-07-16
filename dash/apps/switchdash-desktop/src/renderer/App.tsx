import { QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { AppMenuEvents } from './app/app-menu-events';
import { WelcomeScreen } from './app/welcome';
import { Workspace } from './app/workspace';
import { SessionDeeplinkListener } from './features/switch-rooms/session-deeplink-listener';
import { WorkspaceLayoutContextProvider } from './lib/layout/layout-provider';
import { WorkspaceViewProvider } from './lib/layout/provider';
import { ModalRenderer } from './lib/modal/modal-renderer';
import { ThemeProvider } from './lib/providers/theme-provider';
import { TerminalPoolProvider } from './lib/pty/pty-pool-provider';
import { queryClient } from './lib/query-client';
import { RightSidebarProvider } from './lib/ui/right-sidebar';
import { TooltipProvider } from './lib/ui/tooltip';

export const HAS_SEEN_ONBOARDING = 'switchdash:has-seen-onboarding:v1';

type AppView = 'welcome' | 'workspace';

function AppContent() {
  const [view, setView] = useState<AppView>(() =>
    localStorage.getItem(HAS_SEEN_ONBOARDING) === 'true' ? 'workspace' : 'welcome'
  );

  const handleGetStarted = useCallback(() => {
    localStorage.setItem(HAS_SEEN_ONBOARDING, 'true');
    setView('workspace');
  }, []);

  const handleOpenSettingsFromMenu = useCallback(() => {
    setView('workspace');
    return true;
  }, []);

  const renderContent = () => {
    return (
      <>
        <Workspace />
        {view === 'welcome' && <WelcomeScreen onGetStarted={handleGetStarted} />}
      </>
    );
  };

  return (
    <TooltipProvider delay={300}>
      <WorkspaceLayoutContextProvider>
        <TerminalPoolProvider>
          <WorkspaceViewProvider>
            <AppMenuEvents onOpenSettings={handleOpenSettingsFromMenu} />
            <SessionDeeplinkListener />
            <RightSidebarProvider>
              <ThemeProvider>
                <ModalRenderer />
                {renderContent()}
              </ThemeProvider>
            </RightSidebarProvider>
          </WorkspaceViewProvider>
        </TerminalPoolProvider>
      </WorkspaceLayoutContextProvider>
    </TooltipProvider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  );
}
