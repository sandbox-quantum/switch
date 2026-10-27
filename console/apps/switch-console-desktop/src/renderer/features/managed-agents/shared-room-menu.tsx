import { useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { sharedSessionKey } from '@renderer/features/locations/components/settings-view/sections/shared-session-settings-section';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/lib/ui/context-menu';
import { log } from '@renderer/utils/logger';

/** How a room shows its place in the agent's shared session, beside its name. */
export function sharedSessionMark(mark: 'home' | 'shared' | null | undefined): string | null {
  if (mark === 'home') return 'home';
  if (mark === 'shared') return 'shared';
  return null;
}

/**
 * A room in the agent's Rooms list, with the shared-session actions on its
 * context menu: base the shared session here, have the room share it, or give
 * the room a session of its own. Only the agent's owner or an admin may; a
 * refusal is logged and shown as the server worded it.
 */
export function SharedRoomMenu({
  workspaceId,
  agentId,
  roomId,
  mark,
  hasHome,
  children,
}: {
  workspaceId: string;
  agentId: string;
  roomId: string;
  mark: 'home' | 'shared' | null | undefined;
  /** Whether the agent has a shared session at all. */
  hasHome: boolean;
  /** The room's row: drawn as the menu's trigger, taking its props and ref. */
  children: ReactElement;
}) {
  const queryClient = useQueryClient();
  const act = async (change: () => Promise<void>) => {
    try {
      await change();
    } catch (error) {
      log.error('Failed to change the shared session', { agentId, roomId, error });
      toast({
        title: "Could not change this agent's shared session",
        description: failureText(error, 'Switch refused the change.'),
      });
    } finally {
      void switchRoomsStore.fetchAgentRooms(workspaceId, agentId, { force: true });
      void queryClient.invalidateQueries({ queryKey: sharedSessionKey(workspaceId, agentId) });
    }
  };
  const setHome = (homeRoomId: string | null) =>
    act(() => rpc.workspaces.updateSharedSession({ workspaceId, agentId, change: { homeRoomId } }));
  const setShared = (shared: boolean) =>
    act(() => rpc.workspaces.updateRoomSession({ workspaceId, agentId, roomId, shared }));

  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent>
        {mark !== 'home' && (
          <ContextMenuItem onClick={() => void setHome(roomId)}>
            Base the shared session here
          </ContextMenuItem>
        )}
        {hasHome && !mark && (
          <ContextMenuItem onClick={() => void setShared(true)}>
            Share the agent&rsquo;s session here
          </ContextMenuItem>
        )}
        {mark === 'shared' && (
          <ContextMenuItem onClick={() => void setShared(false)}>
            Give this room its own session
          </ContextMenuItem>
        )}
        {mark === 'home' && (
          <ContextMenuItem onClick={() => void setHome(null)}>
            Stop sharing a session
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
