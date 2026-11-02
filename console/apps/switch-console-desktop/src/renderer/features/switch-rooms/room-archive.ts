import { chatsStore } from '@renderer/features/chats/stores/chats';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';

export type RoomArchiveAction = { label: 'Archive' | 'Unarchive'; run: () => void };

/**
 * Archive or unarchive a room in the signed-in user's own lists. Personal, so
 * anyone who can see the room may, and nothing changes for anyone else or on
 * the room's messaging app. Null until the room's summary has loaded.
 */
export function roomArchiveAction(roomId: string): RoomArchiveAction | null {
  const workspaceId = switchRoomsStore.roomWorkspaceId(roomId) ?? workspacesStore.activeId;
  if (!workspaceId) return null;
  const serverId = workspacesStore.serverIdFor(workspaceId);
  // A chat of yours goes through the chats store, so the chat lists follow too.
  const chat =
    serverId !== null && chatsStore.serverId === serverId ? chatsStore.chat(roomId) : undefined;
  const room = switchRoomsStore.roomSummaryById(roomId);
  if (!chat && !room) return null;
  const archive = !(chat ?? room)?.archivedByViewer;
  const change = () => {
    if (chat && serverId !== null)
      return archive
        ? chatsStore.archive(serverId, roomId)
        : chatsStore.unarchive(serverId, roomId);
    return switchRoomsStore.setRoomArchived(workspaceId, roomId, archive);
  };
  return {
    label: archive ? 'Archive' : 'Unarchive',
    run: () =>
      void change().catch((error: unknown) =>
        toast({
          title: failureText(
            error,
            archive ? 'Could not archive the room.' : 'Could not unarchive the room.'
          ),
          variant: 'destructive',
        })
      ),
  };
}
