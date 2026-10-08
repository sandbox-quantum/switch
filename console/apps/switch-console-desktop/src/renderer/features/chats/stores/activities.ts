import {
  cloudSessionTransport,
  hostJournalTransport,
} from '@renderer/features/sessions/components/transcript/shared-session-transport';
import { events, rpc } from '@renderer/lib/ipc';
import {
  chatActivityChangedChannel,
  chatRemovedChannel,
  chatResetChannel,
} from '@shared/core/chats/chatEvents';
import { roomHealthChangedChannel } from '@shared/core/switch-rooms/switchRoomEvents';
import { AgentActivities } from './chat-activity-store';

/** The app's agent activities, kept in step with placements and access. */
export const agentActivities = new AgentActivities({
  resolve: (serverId, agentId, roomId) => rpc.chats.activity({ serverId, agentId, roomId }),
  transport: (target) =>
    target.cloud
      ? cloudSessionTransport(target.hostAgentKey)
      : hostJournalTransport(target.hostAgentKey),
  reasoning: (hostAgentKey, sessionId, turnIds) =>
    rpc.sdkHost.reasoningList(hostAgentKey, sessionId, turnIds),
  watchPlacements: (serverId, onChange) => events.on(roomHealthChangedChannel, onChange, serverId),
});

events.on(chatActivityChangedChannel, ({ serverId, agentId }) =>
  agentActivities.refresh(serverId, agentId)
);
events.on(chatRemovedChannel, ({ serverId, roomId }) => agentActivities.drop(serverId, roomId));
events.on(chatResetChannel, ({ serverId }) => agentActivities.drop(serverId, null));
