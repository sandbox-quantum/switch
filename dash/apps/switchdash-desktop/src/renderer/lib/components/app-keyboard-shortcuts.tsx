import { useHotkey } from '@tanstack/react-hotkeys';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import {
  getEffectiveHotkey,
  getHotkeyRegistration,
} from '@renderer/lib/hooks/useKeyboardShortcuts';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import {
  useNavigate,
  useParams,
  useWorkspaceSlots,
} from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { modalStore } from '@renderer/lib/modal/modal-store';

export function AppKeyboardShortcuts() {
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const showCommandPalette = useShowModal('commandPaletteModal');
  const { toggleLeft } = useWorkspaceLayoutContext();
  const { navigate } = useNavigate();

  const commandPaletteHotkey = getEffectiveHotkey('commandPalette', keyboard);
  const closeModalHotkey = getEffectiveHotkey('closeModal', keyboard);
  const toggleLeftSidebarHotkey = getEffectiveHotkey('toggleLeftSidebar', keyboard);

  const { currentView, lastNonSettingsView } = useWorkspaceSlots();
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
    getHotkeyRegistration('commandPalette', keyboard),
    () =>
      showCommandPalette({
        locationId: currentLocationId,
        sessionId: currentSessionId,
      }),
    { enabled: commandPaletteHotkey !== null }
  );

  useHotkey(
    getHotkeyRegistration('closeModal', keyboard),
    () => {
      if (currentView === 'settings' && !modalStore.isOpen) {
        (navigate as (viewId: typeof lastNonSettingsView) => void)(lastNonSettingsView);
      }
    },
    { enabled: currentView === 'settings' && closeModalHotkey !== null }
  );

  useHotkey(getHotkeyRegistration('toggleLeftSidebar', keyboard), () => toggleLeft(), {
    enabled: toggleLeftSidebarHotkey !== null,
  });

  return null;
}
