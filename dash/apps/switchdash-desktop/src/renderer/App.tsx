import { QueryClientProvider } from '@tanstack/react-query';
import { AppMenuEvents } from './app/app-menu-events';
import { Workspace } from './app/workspace';
import { SessionDeeplinkListener } from './features/switch-rooms/session-deeplink-listener';
import { SwitchToolsUnavailableListener } from './features/switch-rooms/switch-tools-unavailable-listener';
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
            <SessionDeeplinkListener />
            <SwitchToolsUnavailableListener />
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
