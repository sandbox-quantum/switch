import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { rpc } from '@renderer/lib/ipc';

/**
 * Open a room's bridged channel in the messaging app's desktop client, via the
 * native deeplink the gateway built. No-op when the room has no such link —
 * callers should check {@link switchRoomsStore.roomChannelUrl} first and not
 * offer the action at all rather than present a control that does nothing.
 */
export function openRoomChannel(roomId: string): void {
  const url = switchRoomsStore.roomChannelUrl(roomId);
  if (url) void rpc.app.openExternal(url);
}

/** Open a room's detail page in the gateway web app. */
export function openRoomGatewayPage(roomId: string): void {
  const url = switchRoomsStore.gatewayRoomUrl(roomId);
  if (url) void rpc.app.openExternal(url);
}
