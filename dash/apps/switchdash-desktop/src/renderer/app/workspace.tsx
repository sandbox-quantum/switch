import { LeftSidebar } from '@renderer/features/sidebar/left-sidebar';
import { RoomEmbedLayer } from '@renderer/features/switch-rooms/room-embed-layer';
import { CommandShortcutBinder } from '@renderer/lib/commands/command-shortcut-binder';
import { AppKeyboardShortcuts } from '@renderer/lib/components/app-keyboard-shortcuts';
import { MonacoKeyboardBridge } from '@renderer/lib/components/monaco-keyboard-bridge';
import { useTheme } from '@renderer/lib/hooks/useTheme';
import { useWorkspaceWrapParams } from '@renderer/lib/layout/navigation-provider';
import { WorkspaceContentLayout, WorkspaceLayout } from '@renderer/lib/layout/workspace-layout';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { Toaster } from '@renderer/lib/ui/toaster';

export function Workspace() {
  useTheme();
  const { WrapView } = useWorkspaceSlots();
  const { wrapParams } = useWorkspaceWrapParams();

  return (
    <>
      <AppKeyboardShortcuts />
      <CommandShortcutBinder />
      <MonacoKeyboardBridge />
      <WorkspaceLayout
        leftSidebar={<LeftSidebar />}
        mainContent={
          <WrapView {...wrapParams}>
            <WorkspaceViewContent />
          </WrapView>
        }
        persistentLayer={<RoomEmbedLayer />}
      />
      <Toaster />
    </>
  );
}

function WorkspaceViewContent() {
  const { TitlebarSlot, MainPanel } = useWorkspaceSlots();
  return <WorkspaceContentLayout titlebarSlot={<TitlebarSlot />} mainPanel={<MainPanel />} />;
}
