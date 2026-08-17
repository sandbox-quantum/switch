import { QueryClientProvider } from '@tanstack/react-query';
import { AppMenuEvents } from './app/app-menu-events';
import { UserFacingProblems } from './app/user-facing-problems';
import { Workspace } from './app/workspace';
import { SessionFocusReporter } from './features/sessions/session-focus-reporter-mount';
import { SessionDeeplinkListener } from './features/switch-rooms/session-deeplink-listener';
import { WorkspaceLayoutContextProvider } from './lib/layout/layout-provider';
import { WorkspaceViewProvider } from './lib/layout/provider';
import { ModalRenderer } from './lib/modal/modal-renderer';
import { ThemeProvider } from './lib/providers/theme-provider';
import { TerminalPoolProvider } from './lib/pty/pty-pool-provider';
import { queryClient } from './lib/query-client';
import { RightSidebarProvider } from './lib/ui/right-sidebar';
import { TooltipProvider } from './lib/ui/tooltip';

function AppContent() {
  return (
    <TooltipProvider delay={300}>
      <WorkspaceLayoutContextProvider>
        <TerminalPoolProvider>
          <WorkspaceViewProvider>
            <AppMenuEvents />
            <SessionFocusReporter />
            <SessionDeeplinkListener />
            <UserFacingProblems />
            <RightSidebarProvider>
              <ThemeProvider>
                <ModalRenderer />
                <Workspace />
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
