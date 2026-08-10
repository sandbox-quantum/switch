import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { rpc } from '@renderer/lib/ipc';
import { openExternalUrl, reportOpenAttempt, reportOpenFailure } from '@renderer/lib/open-external';

/**
 * Open a room's bridged channel in the messaging app it lives in, falling back
 * to that app's web client when the app is not installed.
 *
 * Which of the two to open is decided in the main process, because the address
 * a managed stack's Mattermost is reachable on is only known there. No-op when
 * the room has no channel — callers should check
 * {@link switchRoomsStore.roomChannelUrl} first and not offer the action at all
 * rather than present a control that does nothing.
 */
export function openRoomChannel(roomId: string): void {
  const channelUrl = switchRoomsStore.roomChannelUrl(roomId);
  if (!channelUrl) return;

  const failureTitle = `Could not open ${bridgePlatformLabel(switchRoomsStore.roomBridgeTypeById(roomId))}`;
  const serverId = switchRoomsStore.roomServerId(roomId);
  if (!serverId) {
    reportOpenFailure(failureTitle, 'This room’s server is still loading. Try again in a moment.');
    return;
  }

  void reportOpenAttempt(
    rpc.switchRooms.openRoomChannel({ serverId, channelUrl }),
    failureTitle,
    channelUrl
  );
}

/** Open a room's detail page in the gateway web app. */
export function openRoomGatewayPage(roomId: string): void {
  const url = switchRoomsStore.gatewayRoomUrl(roomId);
  if (url) void openExternalUrl(url, 'Could not open the room in the gateway');
}
