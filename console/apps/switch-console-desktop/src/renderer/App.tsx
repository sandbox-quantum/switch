import { QueryClientProvider } from '@tanstack/react-query';
import { BUILD_FEATURE_FLAGS } from '@shared/core/feature-flags/feature-flags';
import { AgentCrudEvents } from './app/agent-crud-events';
import { AppMenuEvents } from './app/app-menu-events';
import { HostSetupEvents } from './app/host-setup-events';
import { Workspace } from './app/workspace';
import { ConsoleLinkListener } from './features/deeplinks/console-link-listener';
import { SessionDeeplinkListener } from './features/switch-rooms/session-deeplink-listener';
import { BridgePlatformsLoader } from './features/switch-servers/bridge-platforms-loader';
import { TelemetryConsentGate } from './features/telemetry/TelemetryConsentGate';
import { WorkspaceLayoutContextProvider } from './lib/layout/layout-provider';
import { WorkspaceViewProvider } from './lib/layout/provider';
import { ModalRenderer } from './lib/modal/modal-renderer';
import { ThemeProvider } from './lib/providers/theme-provider';
import { queryClient } from './lib/query-client';
import { RightSidebarProvider } from './lib/ui/right-sidebar';
import { TooltipProvider } from './lib/ui/tooltip';

function AppContent() {
  return (
    <TooltipProvider delay={300}>
      <WorkspaceLayoutContextProvider>
        <WorkspaceViewProvider>
          <AppMenuEvents />
          <AgentCrudEvents />
          <HostSetupEvents />
          <SessionDeeplinkListener />
          <ConsoleLinkListener />
          <BridgePlatformsLoader />
          <RightSidebarProvider>
            <ThemeProvider>
              <ModalRenderer />
              {/* The first-run pages say it themselves when they are on. */}
              {!BUILD_FEATURE_FLAGS.onboarding && <TelemetryConsentGate />}
              <Workspace />
            </ThemeProvider>
          </RightSidebarProvider>
        </WorkspaceViewProvider>
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
