import { computed } from 'mobx';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';
import {
  hidesConsoleDirectChats,
  isConsoleDirectChat,
  withConsoleGroupChats,
} from './room-filters';
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
 * Without the Switch Console chats the user is not in: they cannot open one. Only
 * the chat list knows, and it follows the active workspace's server, so a chat
 * elsewhere is left out until that workspace is the active one.
 */
function withoutChatsYouAreNotIn(
  rooms: RemoteRoomSummary[],
  serverId: string | null
): RemoteRoomSummary[] {
  const following = serverId !== null && chatsStore.serverId === serverId;
  return rooms.filter(
    (room) =>
      !room.isConsoleChat ||
      (following && (chatsStore.chats.has(room.id) || chatsStore.unlisted.has(room.id)))
  );
}

/**
 * Rooms listed in the sidebar and on the Your Rooms page, filtered by the
 * agent_chats flag: when on, the group chats you are in are listed, and 1-1
 * Console chats (see `isConsoleDirectChat`) are hidden where agent management
 * lists them on their agent's page. Bridged DMs and multi-agent rooms stay
 * visible.
 */
export function useListedRoomsInActiveScope(): RemoteRoomSummary[] {
  const flags = useFeatureFlags(switchServersStore.activeServerId);
  const serverId = switchServersStore.activeServerId;
  return computed(() =>
    withConsoleGroupChats(
      withoutChatsYouAreNotIn(
        filterConsoleDirectChats(
          switchRoomsStore.listedRoomsInActiveScope,
          hidesConsoleDirectChats(flags)
        ),
        serverId
      ),
      flags.agent_chats ? chatsStore.chats.values() : [],
      !hidesConsoleDirectChats(flags)
    )
  ).get();
}

/**
 * Readable rooms in a workspace, filtered by the agent_chats flag when on, with
 * the group chats you are in when it is the active workspace, which is the one
 * chats follow.
 */
export function useReadableRoomsInWorkspace(workspaceId: string | null): RemoteRoomSummary[] {
  return useRoomsInWorkspace(workspaceId, (id) => switchRoomsStore.readableRoomsInWorkspace(id));
}

/** {@link useReadableRoomsInWorkspace}, narrowed to the rooms the sidebar lists: yours. */
export function useListedRoomsInWorkspace(workspaceId: string | null): RemoteRoomSummary[] {
  return useRoomsInWorkspace(workspaceId, (id) => switchRoomsStore.listedRoomsInWorkspace(id));
}

function useRoomsInWorkspace(
  workspaceId: string | null,
  rooms: (workspaceId: string) => RemoteRoomSummary[]
): RemoteRoomSummary[] {
  const serverId = workspaceId && workspacesStore.serverIdFor(workspaceId);
  const flags = useFeatureFlags(serverId);
  if (workspaceId === null) return [];
  const active = workspaceId === workspacesStore.activeId;
  return withConsoleGroupChats(
    withoutChatsYouAreNotIn(
      filterConsoleDirectChats(rooms(workspaceId), hidesConsoleDirectChats(flags)),
      active ? serverId : null
    ),
    flags.agent_chats && workspaceId === workspacesStore.activeId ? chatsStore.chats.values() : [],
    !hidesConsoleDirectChats(flags)
  );
}
