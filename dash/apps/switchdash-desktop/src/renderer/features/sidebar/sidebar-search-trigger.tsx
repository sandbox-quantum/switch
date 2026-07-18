import { Search } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useParams, useWorkspaceSlots } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { SidebarMenuButton } from './sidebar-primitives';

export const SidebarSearchTrigger = observer(function SidebarSearchTrigger() {
  const showCommandPalette = useShowModal('commandPaletteModal');
  const { currentView } = useWorkspaceSlots();
  const { params: sessionParams } = useParams('session');
  const { params: locationParams } = useParams('location');

  const currentLocationId =
    currentView === 'session'
      ? sessionParams.locationId
      : currentView === 'location'
        ? locationParams.locationId
        : undefined;
  const currentSessionId = currentView === 'session' ? sessionParams.sessionId : undefined;

  return (
    <SidebarMenuButton
      isActive={false}
      onClick={() =>
        showCommandPalette({
          locationId: currentLocationId,
          sessionId: currentSessionId,
        })
      }
      aria-label="Search"
      className="w-full justify-between"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Search className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
        <span className="truncate">Search…</span>
      </span>
      <BoundShortcut settingsKey="commandPalette" />
    </SidebarMenuButton>
  );
});
