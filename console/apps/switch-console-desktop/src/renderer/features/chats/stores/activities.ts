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

events.on(chatActivityChannel, ({ serverId, item }) => agentActivities.applyItem(serverId, item));
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
