import { AlertTriangle } from 'lucide-react';
import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { ManagedAgentList } from '@renderer/features/managed-agents/managed-agent-list';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import { useBuddyPending } from '@renderer/features/switch-buddy/buddy-pending';
import { switchRoomsStore as roomConnectionsStore } from '@renderer/features/switch-rooms/switch-rooms-store';
import { isFrozenServer } from '@renderer/features/switch-servers/managed-server-state';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { useListedRoomsInActiveScope } from '@renderer/features/switch-servers/use-listed-rooms';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { events, rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { userChangesChannel } from '@shared/events/userChangesEvents';
import { AgentTree } from './agent-tree';
import { SidebarMainSection } from './main-section';
import { RoomTree } from './room-tree';
import { SessionDiscoveryStatus } from './session-discovery-status';
import { SessionsSectionHeader } from './sessions-section-header';
import { useScrollSelectionIntoView } from './sidebar-auto-scroll';
import { showsAgentsAndRooms, sidebarEmptyState } from './sidebar-empty-state';
import { POLLED_RECONCILE_MS, SidebarRoomPushes } from './sidebar-room-pushes';
import { agentsInActiveScope, refreshSidebarRoomState } from './sidebar-tree-data';

/** @see refreshSidebarRoomState — shared so every trigger, including the
 * mutations in other components, refreshes the same set. */
const loadSidebarState = refreshSidebarRoomState;

/** The workspaces on screen whose server is connected: the ones whose rooms are read. */
function connectedWorkspacesInScope(): { workspaceId: string; serverId: string }[] {
  const activeId = workspacesStore.activeId;
  return workspacesStore.workspaces
    .filter((w) => (activeId ? w.id === activeId : true))
    .filter((w) => switchServersStore.isConnected(w.serverId))
    .map((w) => ({ workspaceId: w.id, serverId: w.serverId }));
}

/**
 * The sidebar body: loads what both trees read, then hands over to whichever
 * one the current grouping calls for.
 *
 * Agents-first and rooms-first are genuinely different views — different
 * subjects, different nesting, different row actions — so they are separate
 * components rather than one tree with the levels swapped.
 */
export const SidebarGroupedList = observer(function SidebarGroupedList() {
  // The tree's only scroller, and so the only place that has to keep the
  // selected row — session, agent, agent-under-room or room — in view.
  const scrollerRef = useRef<HTMLDivElement>(null);
  useScrollSelectionIntoView(scrollerRef);

  useEffect(() => {
    roomConnectionsStore.ensureLoaded();
    void hostReachabilityStore.hydrate();
    // The servers push what changes in their rooms; this reads it.
    const pushes = new SidebarRoomPushes({
      refreshAll: () => loadSidebarState(true),
      refreshRooms: (workspaceId, roomIds) => switchRoomsStore.refreshRooms(workspaceId, roomIds),
      watch: (serverId, workspaceId) => rpc.userChanges.watch(serverId, workspaceId),
      unwatch: (serverId, workspaceId) => rpc.userChanges.unwatch(serverId, workspaceId),
      liveKinds: (serverId, workspaceId) => rpc.userChanges.liveKinds(serverId, workspaceId),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (timer) => clearTimeout(timer),
    });
    const stopPushes = events.on(userChangesChannel, (event) => pushes.onEvent(event));
    // The servers have to be known before their rooms can be asked for, but the
    // agents and their membership do not wait on that.
    void loadSidebarState(false);
    void switchServersStore.init().then(() => switchRoomsStore.loadRoomNames());

    const onFocus = () => {
      if (pushes.focusDue()) void pushes.readWhole();
    };
    window.addEventListener('focus', onFocus);

    // Two things make the loaded state wrong without any mutation here:
    // signing in to a server (its rooms were skipped while disconnected, and
    // nothing re-ran the load), and switching which workspace is active — only
    // the workspace on screen is loaded, so the one you switch to may never have
    // been, even on the same server.
    const stopWatchingServers = reaction(
      () => ({
        active: workspacesStore.activeId,
        connected: switchServersStore.servers
          .filter((s) => switchServersStore.isConnected(s.id))
          .map((s) => s.id)
          .sort()
          .join(','),
      }),
      () => {
        pushes.follow(connectedWorkspacesInScope());
        void pushes.readWhole();
      },
      { equals: (a, b) => a.active === b.active && a.connected === b.connected }
    );
    pushes.follow(connectedWorkspacesInScope());

    // A membership changed from Slack, the gateway or another install is
    // pushed by servers that have the change socket, and is otherwise invisible
    // until something asks again. Focus is not enough on its own (a window left
    // in the foreground never refocuses), so reconcile on a timer as well: every
    // tick while some workspace is not pushed, every few minutes while all are,
    // for a notice that was lost.
    const reconcile = setInterval(() => {
      if (document.hidden) return;
      if (pushes.reconcileDue()) void pushes.readWhole();
    }, POLLED_RECONCILE_MS);

    return () => {
      window.removeEventListener('focus', onFocus);
      stopPushes();
      pushes.stop();
      stopWatchingServers();
      clearInterval(reconcile);
    };
  }, []);

  const managedAgents = useManagedAgents(switchServersStore.activeServerId);
  const activeServerId = switchServersStore.activeServerId;
  const managementMode = useAgentManagementMode();
  const buddyPending = useBuddyPending(activeServerId);
  const listedRooms = useListedRoomsInActiveScope();
  const managedAgentCount = activeServerId && managedAgents.data ? managedAgents.data.length : 0;
  const emptyState = sidebarEmptyState({
    grouping: sidebarStore.grouping,
    hasActiveFilters: sidebarStore.hasActiveFilters,
    filteredLocationCount: sidebarStore.filteredLocations.length,
    activeServerId: switchServersStore.activeServerId,
    locationCount: sidebarStore.orderedLocations.length,
    roomCount: listedRooms.length,
    serverListedAgentCount: managedAgentCount,
  });

  if (managementMode) {
    const managedIds = new Set((managedAgents.data ?? []).map((agent) => agent.agentId));
    const legacyCount = agentsInActiveScope().filter(
      (entry) =>
        !agentsStore.isMoved(entry.agent.id) &&
        (entry.agent.switchAgentId === null || !managedIds.has(entry.agent.switchAgentId))
    ).length;
    return (
      <div
        ref={scrollerRef}
        className="flex min-h-0 flex-1 flex-col gap-[2px] overflow-y-auto px-2.5 pt-0 pb-3"
      >
        <RoomStateDisclosure />
        {/* Sessions only while some agent still runs the old way, and gone
            once none does. */}
        {showsAgentsAndRooms({
          managedAgentCount,
          buddyPending,
          legacyAgentCount: legacyCount,
        }) && <SidebarMainSection />}
        {legacyCount > 0 && (
          <>
            <SessionsSectionHeader legacy />
            <SessionDiscoveryStatus />
            <AgentTree />
          </>
        )}
      </div>
    );
  }

  return (
    <div
      ref={scrollerRef}
      className="flex min-h-0 flex-1 flex-col gap-[2px] overflow-y-auto px-2 pt-0 pb-3"
    >
      <RoomStateDisclosure />
      {emptyState === 'no-filter-match' ? (
        <p className="px-2 py-3 text-xs text-foreground-muted">No agents match filters</p>
      ) : emptyState === 'empty' ? (
        <p className="px-2 py-3 text-xs text-foreground-muted">
          No sessions running on this server.
        </p>
      ) : sidebarStore.grouping === 'room' ? (
        <RoomTree />
      ) : (
        <AgentTree />
      )}
      {sidebarStore.grouping !== 'room' && <ManagedAgentList />}
    </div>
  );
});

/**
 * Whether the server on screen runs agent management, which is what turns the
 * sidebar into Agents / Rooms with the old Sessions list below as legacy. A
 * server without it keeps the sidebar it always had.
 */
export function useAgentManagementMode(): boolean {
  return useFeatureFlags(switchServersStore.activeServerId).agent_management;
}

/**
 * Says so when the room state on screen is known to be incomplete.
 *
 * The tree renders last-known rooms and memberships when a refresh fails, which
 * is the right thing to do — but rendering them silently would present a partial
 * view as the whole truth. A room missing its members and a room with no members
 * look identical otherwise.
 */
const RoomStateDisclosure = observer(function RoomStateDisclosure() {
  const { navigate } = useNavigate();
  // The banner over a frozen workspace is the whole explanation.
  const active = switchServersStore.activeServer;
  if (active && isFrozenServer(active)) return null;
  const signedOut = switchRoomsStore.workspacesNotSignedIn;
  const failed = switchRoomsStore.workspacesThatFailedToLoad;

  // Being signed out is the whole explanation, so it is said on its own: the
  // memberships that "didn't load" are the same fact, and offering a retry for
  // something only a sign-in can fix sends the user in a circle.
  if (signedOut.length > 0) {
    return (
      <DisclosureBar>
        Sign in to {signedOut.map((s) => s.name).join(', ')} to see{' '}
        {signedOut.length === 1 ? 'its' : 'their'} rooms.{' '}
        <DisclosureAction onClick={() => navigate('server', { serverId: signedOut[0].serverId })}>
          Sign in
        </DisclosureAction>
      </DisclosureBar>
    );
  }

  const unknownMemberships = switchRoomsStore.agentsWithUnknownMembership;
  if (failed.length === 0 && unknownMemberships === 0) return null;

  const reasons: string[] = [];
  if (failed.length > 0) {
    reasons.push(
      `couldn’t get them from your Switch server (${failed.length === 1 ? 'workspace' : 'workspaces'} ${failed.map((s) => `“${s.name}”`).join(', ')})`
    );
  }
  if (unknownMemberships > 0) {
    reasons.push(
      `${unknownMemberships} ${unknownMemberships === 1 ? 'agent’s' : 'agents’'} rooms didn’t load`
    );
  }

  return (
    <DisclosureBar>
      Rooms may be out of date — {reasons.join('; ')}.{' '}
      <DisclosureAction onClick={() => void loadSidebarState(true)}>Retry</DisclosureAction>
    </DisclosureBar>
  );
});

function DisclosureBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 flex items-start gap-1.5 rounded-md bg-background-secondary px-2 py-1.5 text-xs text-foreground-muted">
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function DisclosureAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="underline underline-offset-2 hover:text-foreground"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
