import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import {
  isConsoleDirectChatSummary,
  isConsoleGroupChatSummary,
} from '@renderer/features/switch-servers/room-filters';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { appState } from '@renderer/lib/stores/app-state';
import { consoleChatRoute } from './console-chat-route';
import { chatsStore } from './stores/chats';

/**
 * Whether the room page shows a room as a Console chat: a group chat, or a
 * chat just lost, whose panel says so rather than falling back to the room's
 * messaging app.
 */
export function opensAsConsoleChat(roomId: string): boolean {
  const chat = chatsStore.chat(roomId);
  return chat ? isConsoleGroupChatSummary(chat) : chatsStore.removed.has(roomId);
}

/** The chat to open as a room: the one shown, once it is a group. */
export function groupToOpenAsRoom(roomId: string | null): string | null {
  if (roomId === null) return null;
  const chat = chatsStore.chat(roomId);
  return chat !== undefined && isConsoleGroupChatSummary(chat) ? roomId : null;
}

/**
 * A group chat opens as a room, including a direct chat the moment it becomes
 * one; its draft and loaded messages are held by chat, so they come along.
 * `from` is the view showing it, whose history entry for the chat is dropped
 * so Back does not return there and open the room again.
 */
export function useOpenGroupAsRoom(roomId: string | null, from: 'chat' | 'managedAgent'): void {
  const group = groupToOpenAsRoom(roomId);
  useEffect(() => {
    if (group === null) return;
    appState.history.prune(
      (entry) =>
        entry.kind === 'view' &&
        entry.viewId === from &&
        (entry.params as { roomId?: string }).roomId === group
    );
    appState.navigation.navigate('room', { roomId: group });
  }, [group, from]);
}

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
