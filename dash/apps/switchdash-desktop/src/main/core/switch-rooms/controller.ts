import type { RoomEmbed } from '@shared/core/switch-rooms/room-embed';
import type { SessionRoomConnection } from '@shared/core/switch-rooms/switch-rooms';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { resolveChannelEmbed } from './mattermost-embed';
import { switchRoomService } from './switch-room-service';

export const switchRoomsController = createRPCController({
  getConnections: (): SessionRoomConnection[] => switchRoomService.getConnections(),

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
  }): Promise<RoomEmbed> => resolveChannelEmbed(params),
});
