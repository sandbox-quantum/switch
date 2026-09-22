import { observer } from 'mobx-react-lite';
import { useEffect, type ReactNode } from 'react';
import { WelcomePage } from '@renderer/features/onboarding/welcome-page';
import { LeftSidebar } from '@renderer/features/sidebar/left-sidebar';
import { RoomEmbedLayer } from '@renderer/features/switch-rooms/room-embed-layer';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { CommandShortcutBinder } from '@renderer/lib/commands/command-shortcut-binder';
import { AppKeyboardShortcuts } from '@renderer/lib/components/app-keyboard-shortcuts';
import { MonacoKeyboardBridge } from '@renderer/lib/components/monaco-keyboard-bridge';
import { useTheme } from '@renderer/lib/hooks/useTheme';
import { useCurrentViewId, useWorkspaceWrapParams } from '@renderer/lib/layout/navigation-provider';
import { WorkspaceContentLayout, WorkspaceLayout } from '@renderer/lib/layout/workspace-layout';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { Toaster } from '@renderer/lib/ui/toaster';
import { shellShape } from './shell-shape';
import { viewWorksWithoutServer } from './view-registry';

/**
 * What fills the window.
 *
 * Two shapes, not one: the workspace — sidebar, views, the room layer — and the
 * onboarding flow that takes the whole window before there is any server to
 * show. The choice is made here rather than inside a view because it is the
 * chrome itself that differs; an onboarding page rendered into the workspace
 * would sit beside a sidebar listing nothing.
 *
 * The server list is read here for the same reason. It used to be loaded by the
 * sidebar, which is no longer always mounted, and the shell cannot ask a
 * component it may not render which shape to take.
 */
export const Workspace = observer(function Workspace() {
  useTheme();
  const { WrapView } = useWorkspaceSlots();
  const { wrapParams } = useWorkspaceWrapParams();

  useEffect(() => {
    void switchServersStore.init();
  }, []);

  return (
    <>
      <AppKeyboardShortcuts />
      <CommandShortcutBinder />
      <MonacoKeyboardBridge />
      <Shell
        mainContent={
          <WrapView {...wrapParams}>
            <WorkspaceViewContent />
          </WrapView>
        }
      />
      <Toaster />
    </>
  );
});

const Shell = observer(function Shell({ mainContent }: { mainContent: ReactNode }) {
  const currentViewId = useCurrentViewId();
  const shape = shellShape({
    loaded: switchServersStore.loaded,
    listError: switchServersStore.listError,
    serverCount: switchServersStore.servers.length,
    viewWorksWithoutServer: viewWorksWithoutServer(currentViewId),
  });

  switch (shape) {
    // Nothing on screen rather than a spinner: this is one or two local IPC
    // round-trips, and a spinner that flashes is worse than a beat of window.
    case 'loading':
      return null;
    case 'failed':
      return (
        <ShellFailure
          message={switchServersStore.listError ?? 'Could not load your Switch servers.'}
          detail={switchServersStore.listErrorDetail}
          retrying={switchServersStore.loadingServers}
        />
      );
    case 'onboarding':
      return <WelcomePage />;
    case 'workspace':
      return (
        <WorkspaceLayout
          leftSidebar={<LeftSidebar />}
          mainContent={mainContent}
          persistentLayer={<RoomEmbedLayer />}
        />
      );
  }
});

/**
 * The window when the first read of the server list failed.
 *
 * A retry runs on this page rather than replacing it. The read clears nothing
 * as it starts, so the message, the detail and the button all stay put and the
 * button says it is working — otherwise pressing it would unmount the only
 * thing on screen and leave a blank window for as long as the retry took.
 */
function ShellFailure({
  message,
  detail,
  retrying,
}: {
  message: string;
  detail: string | null;
  retrying: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-background p-8 text-center [-webkit-app-region:drag]">
      <p className="text-sm text-foreground">{message}</p>
      {detail && <p className="max-w-md text-xs text-foreground-muted">{detail}</p>}
      <Button
        className="[-webkit-app-region:no-drag]"
        variant="outline"
        disabled={retrying}
        onClick={() => void switchServersStore.init()}
      >
        {retrying && <Spinner size="sm" className="mr-2" />}
        {retrying ? 'Trying again…' : 'Try again'}
      </Button>
    </div>
  );
}

function WorkspaceViewContent() {
  const { TitlebarSlot, MainPanel } = useWorkspaceSlots();
  return <WorkspaceContentLayout titlebarSlot={<TitlebarSlot />} mainPanel={<MainPanel />} />;
}
