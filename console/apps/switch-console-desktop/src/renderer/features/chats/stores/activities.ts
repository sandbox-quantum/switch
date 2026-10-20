import { changesRooms } from '@renderer/features/switch-servers/room-changing-tools';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { events, rpc } from '@renderer/lib/ipc';
import {
  chatActivityChannel,
  chatActivityResyncChannel,
  chatActivityStateChannel,
  chatApprovalChannel,
  chatRemovedChannel,
  chatResetChannel,
} from '@shared/core/chats/chatEvents';
import { roomHealthChangedChannel } from '@shared/core/switch-rooms/switchRoomEvents';
import { AgentActivities } from './chat-activity-store';

/** How long to gather room changes before re-reading: a template makes several at once. */
const ROOM_REFRESH_DELAY_MS = 500;

/** The app's agent activities, kept in step with the activity feed, placements and access. */
export const agentActivities = new AgentActivities(
  {
    resolve: (serverId, agentId, roomId) => rpc.chats.activity({ serverId, agentId, roomId }),
    reasoning: (hostAgentKey, sessionId, turnIds) =>
      rpc.sdkHost.reasoningList(hostAgentKey, sessionId, turnIds),
    watchPlacements: (serverId, onChange) =>
      events.on(roomHealthChangedChannel, onChange, serverId),
    roomActivity: (serverId, roomId) => rpc.chats.roomActivity(serverId, roomId),
    control: (input) => rpc.chats.control(input),
    answerApproval: (input) => rpc.chats.answerApproval(input),
  },
  sessionStorage
);

let roomRefresh: ReturnType<typeof setTimeout> | null = null;

/**
 * Nothing pushes room state to the app, so a room an agent creates or joins
 * would wait for the next reconcile. Its finished tool call is the signal.
 */
function refreshRoomsSoon(): void {
  if (roomRefresh !== null) clearTimeout(roomRefresh);
  roomRefresh = setTimeout(() => {
    roomRefresh = null;
    void switchRoomsStore.refreshRoomState();
  }, ROOM_REFRESH_DELAY_MS);
}

events.on(chatActivityChannel, ({ serverId, item }) => {
  agentActivities.applyItem(serverId, item);
  if (changesRooms(item)) refreshRoomsSoon();
});
events.on(chatApprovalChannel, ({ serverId, approval }) =>
  agentActivities.applyApproval(serverId, approval)
);
events.on(chatActivityResyncChannel, ({ serverId }) => agentActivities.resync(serverId));
events.on(chatActivityStateChannel, ({ serverId, state, detail }) =>
  agentActivities.feedState(serverId, state, detail)
);
events.on(chatRemovedChannel, ({ serverId, roomId, reason }) => {
  if (reason === 'access') agentActivities.drop(serverId, roomId);
});
events.on(chatResetChannel, ({ serverId }) => agentActivities.drop(serverId, null));
