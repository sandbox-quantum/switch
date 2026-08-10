import type { MattermostTheme } from '@shared/core/switch-rooms/mattermost-theme';
import type { RoomEmbed } from '@shared/core/switch-rooms/room-embed';
import type { SessionRoomConnection } from '@shared/core/switch-rooms/switch-rooms';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { resolveChannelEmbed } from './mattermost-embed';
import { openRoomChannel } from './open-channel';
import { switchNotificationPoller } from './switch-notification-poller';
import { switchRoomService } from './switch-room-service';

export const switchRoomsController = createRPCController({
  getConnections: (): SessionRoomConnection[] => switchRoomService.getConnections(),

  /**
   * Declare the room a session is being started for, before it is spawned. The
   * session's connection then opens already claiming that room, so it appears
   * under it immediately instead of after the agent's first `connect_to_room`.
   */
  noteIntendedRoom: (params: {
    sessionId: string;
    roomId: string;
    roomName: string | null;
  }): void =>
    switchNotificationPoller.noteIntendedRoom(params.sessionId, params.roomId, params.roomName),

  /**
   * Decide how a room's conversation should be shown, and prepare whatever
   * that needs (a logged-in Mattermost partition, for the inline case). Called
   * by the room view before rendering, and again on retry — a failure here is
   * usually a Mattermost that has not finished starting.
   */
  resolveRoomEmbed: (params: {
    serverId: string;
    bridgeType: string | null;
    externalChannelUrl: string | null;
    theme: MattermostTheme | null;
  }): Promise<RoomEmbed> => resolveChannelEmbed(params),

  /**
   * Open a room's channel in the messaging app it is bridged to, or the browser
   * when that app is not installed. Reports why it could not rather than
   * leaving a click that appears to do nothing.
   */
  openRoomChannel: async (params: {
    serverId: string;
    channelUrl: string;
  }): Promise<{ success: true } | { success: false; error: string }> => {
    try {
      await openRoomChannel(params);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
});
