import { openServerPage } from '@renderer/features/switch-servers/open-server-page';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { rpc } from '@renderer/lib/ipc';
import { reportOpenAttempt } from '@renderer/lib/open-external';

/**
 * Open a room's bridged channel in the messaging app it lives in, falling back
 * to that app's web client when the app is not installed. No-op when the room
 * has no channel — callers should check
 * {@link switchRoomsStore.roomChannelUrl} first and not offer the action at all
 * rather than present a control that does nothing.
 */
export function openRoomChannel(roomId: string): void {
  const channelUrl = switchRoomsStore.roomChannelUrl(roomId);
  if (!channelUrl) return;

  const failureTitle = `Could not open ${bridgePlatformLabel(switchRoomsStore.roomBridgeTypeById(roomId))}`;
  void reportOpenAttempt(rpc.switchRooms.openRoomChannel({ channelUrl }), failureTitle, channelUrl);
}

/** Open a room's detail page in the gateway web app. */
export function openRoomGatewayPage(roomId: string): void {
  const url = switchRoomsStore.gatewayRoomUrl(roomId);
  const serverId = switchRoomsStore.roomServerId(roomId);
  if (url && serverId) void openServerPage(serverId, url);
}
