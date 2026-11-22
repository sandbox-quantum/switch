import { useHotkey } from '@tanstack/react-hotkeys';
import {
  getEffectiveHotkey,
  getHotkeyRegistration,
} from '@renderer/lib/hooks/useKeyboardShortcuts';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { useShowModal } from '@renderer/lib/modal/modal-provider';

export function AppKeyboardShortcuts() {
  const showCommandPalette = useShowModal('commandPaletteModal');
  const { toggleLeft } = useWorkspaceLayoutContext();

  const commandPaletteHotkey = getEffectiveHotkey('commandPalette');
  const toggleLeftSidebarHotkey = getEffectiveHotkey('toggleLeftSidebar');

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

  useHotkey(
    getHotkeyRegistration('commandPalette'),
    () =>
      showCommandPalette({
        locationId: currentLocationId,
        sessionId: currentSessionId,
      }),
    { enabled: commandPaletteHotkey !== null }
  );

  useHotkey(getHotkeyRegistration('toggleLeftSidebar'), () => toggleLeft(), {
    enabled: toggleLeftSidebarHotkey !== null,
  });

  return null;
}
