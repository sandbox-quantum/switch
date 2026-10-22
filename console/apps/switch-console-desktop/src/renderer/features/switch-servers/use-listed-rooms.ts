import { computed } from 'mobx';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';
import { isConsoleDirectChat, withConsoleGroupChats } from './room-filters';
import { switchRoomsStore } from './switch-rooms-store';
import { switchServersStore } from './switch-servers-store';

function filterConsoleDirectChats(
  rooms: RemoteRoomSummary[],
  hideDirectChats: boolean
): RemoteRoomSummary[] {
  if (!hideDirectChats) return rooms;
  return rooms.filter((room) => !isConsoleDirectChat(room));
}

/**
 * Rooms listed in the sidebar and on the Your Rooms page, filtered by the
 * agent_chats flag: when on, 1-1 Console chats (see `isConsoleDirectChat`)
 * are hidden and the group chats you are in are listed. Bridged DMs and
 * multi-agent rooms stay visible.
 */
export function useListedRoomsInActiveScope(): RemoteRoomSummary[] {
  const flags = useFeatureFlags(switchServersStore.activeServerId);
  return computed(() =>
    withConsoleGroupChats(
      filterConsoleDirectChats(switchRoomsStore.listedRoomsInActiveScope, flags.agent_chats),
      flags.agent_chats ? chatsStore.chats.values() : []
    )
  ).get();
}

/**
 * Readable rooms in a workspace, filtered by the agent_chats flag when on, with
 * the group chats you are in when it is the active workspace, which is the one
 * chats follow.
 */
export function useReadableRoomsInWorkspace(workspaceId: string | null): RemoteRoomSummary[] {
  const flags = useFeatureFlags(workspaceId && workspacesStore.serverIdFor(workspaceId));
  if (workspaceId === null) return [];
  return withConsoleGroupChats(
    filterConsoleDirectChats(
      switchRoomsStore.readableRoomsInWorkspace(workspaceId),
      flags.agent_chats
    ),
    flags.agent_chats && workspaceId === workspacesStore.activeId ? chatsStore.chats.values() : []
  );
}
