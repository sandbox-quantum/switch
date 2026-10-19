import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { isConsoleDirectChatSummary } from '@renderer/features/switch-servers/room-filters';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { appState } from '@renderer/lib/stores/app-state';
import { consoleChatRoute } from './console-chat-route';
import { chatsStore } from './stores/chats';

/**
 * On the room page, with agent_chats on: a 1-1 Console chat is not a room, so
 * it opens in the chat UI instead, whether reached from a deep link, search, a
 * notification or the view restored at start. The room page leaves history so
 * Back does not return to it and redirect again.
 */
export const ConsoleChatRedirect = observer(function ConsoleChatRedirect({
  roomId,
}: {
  roomId: string;
}): null {
  const serverId = switchRoomsStore.roomServerId(roomId) ?? chatsStore.serverId;
  const enabled = useFeatureFlags(serverId).agent_chats;
  const managed = useManagedAgents(serverId);
  const chat = chatsStore.serverId === serverId ? chatsStore.chat(roomId) : undefined;
  const agent = chat && isConsoleDirectChatSummary(chat) ? chat.agents[0] : undefined;
  const isManaged = managed.data?.some((each) => each.agentId === agent?.id) ?? false;

  useEffect(() => {
    if (!enabled || !serverId || !agent || managed.isLoading) return;
    const route = consoleChatRoute(serverId, roomId, agent, isManaged);
    appState.history.prune(
      (entry) =>
        entry.kind === 'view' &&
        entry.viewId === 'room' &&
        (entry.params as { roomId?: string }).roomId === roomId
    );
    if (route.viewId === 'managedAgent') appState.navigation.navigate('managedAgent', route.params);
    else appState.navigation.navigate('chat', route.params);
  }, [enabled, serverId, roomId, agent, isManaged, managed.isLoading]);

  return null;
});
