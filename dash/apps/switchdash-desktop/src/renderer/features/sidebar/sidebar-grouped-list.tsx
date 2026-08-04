import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import { switchRoomsStore as roomConnectionsStore } from '@renderer/features/switch-rooms/switch-rooms-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { AgentTree } from './agent-tree';
import { RoomTree } from './room-tree';
import { switchIdentities } from './sidebar-tree-data';

/**
 * The sidebar body: loads what both trees read, then hands over to whichever
 * one the current grouping calls for.
 *
 * Agents-first and rooms-first are genuinely different views — different
 * subjects, different nesting, different row actions — so they are separate
 * components rather than one tree with the levels swapped.
 */
export const SidebarGroupedList = observer(function SidebarGroupedList() {
  // Live session→room connections, room names and room membership all live on
  // the server; pull them once on mount and refresh on focus.
  useEffect(() => {
    roomConnectionsStore.ensureLoaded();
    void hostReachabilityStore.hydrate();
    // Room membership is what puts an agent under a room, so it is loaded for
    // every agent up front rather than lazily per row.
    const loadRooms = async (force: boolean) => {
      await agentsStore.load();
      await switchRoomsStore.ensureMembershipsFor(switchIdentities(), { force });
    };
    void loadRooms(false);
    void switchServersStore.init().then(() => switchRoomsStore.loadRoomNames());
    const onFocus = () => {
      void loadRooms(true);
      void switchRoomsStore.loadRoomNames();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // Agent filters narrowing everything away is only an empty *agent* list. The
  // room view lists rooms, which are still there, and reports its own filters
  // being too narrow itself.
  const showFilterEmptyState =
    sidebarStore.grouping !== 'room' &&
    sidebarStore.hasActiveFilters &&
    sidebarStore.filteredLocations.length === 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-3">
      {showFilterEmptyState ? (
        <p className="px-2 py-3 text-xs text-foreground-muted">No agents match filters</p>
      ) : sidebarStore.grouping === 'room' ? (
        <RoomTree />
      ) : (
        <AgentTree />
      )}
    </div>
  );
});
