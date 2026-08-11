import { AlertTriangle } from 'lucide-react';
import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import { switchRoomsStore as roomConnectionsStore } from '@renderer/features/switch-rooms/switch-rooms-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { AgentTree } from './agent-tree';
import { RoomTree } from './room-tree';
import { useScrollSelectionIntoView } from './sidebar-auto-scroll';
import { switchIdentities } from './sidebar-tree-data';

/**
 * How often the room state is reconciled against the servers while the window
 * is visible. Slow on purpose: it is a safety net for changes made outside this
 * app, not the primary path — mutations made here refresh immediately.
 */
const ROOM_STATE_RECONCILE_MS = 60_000;

/**
 * Re-read everything the sidebar's trees are built from: this install's agents,
 * their room membership, and the room catalogue.
 *
 * One function for every "catch up with the world" trigger — first paint, window
 * focus, signing in to a server, the background reconcile, the retry button. The
 * bug being fixed here is triggers refreshing different subsets, so they share
 * one.
 */
async function loadSidebarState(force: boolean): Promise<void> {
  await agentsStore.load();
  await Promise.all([
    switchRoomsStore.ensureMembershipsFor(switchIdentities(), { force }),
    switchRoomsStore.loadRoomNames(),
  ]);
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
    // The servers have to be known before their rooms can be asked for, but the
    // agents and their membership do not wait on that.
    void loadSidebarState(false);
    void switchServersStore.init().then(() => switchRoomsStore.loadRoomNames());

    const onFocus = () => void loadSidebarState(true);
    window.addEventListener('focus', onFocus);

    // Two things make the loaded state wrong without any mutation here:
    // signing in to a server (its rooms were skipped while disconnected, and
    // nothing re-ran the load), and switching which server is active — only the
    // server on screen is loaded, so the one you switch to may never have been.
    const stopWatchingServers = reaction(
      () => ({
        active: switchServersStore.activeServerId,
        connected: switchServersStore.servers
          .filter((s) => switchServersStore.isConnected(s.id))
          .map((s) => s.id)
          .sort()
          .join(','),
      }),
      () => void loadSidebarState(true),
      { equals: (a, b) => a.active === b.active && a.connected === b.connected }
    );

    // Nothing pushes room state to the app: a membership changed from Slack,
    // the gateway or another install is invisible until something asks again.
    // Focus is not enough on its own — a window left in the foreground never
    // refocuses — so reconcile on a slow timer as well.
    const reconcile = setInterval(() => {
      if (document.hidden) return;
      void loadSidebarState(true);
    }, ROOM_STATE_RECONCILE_MS);

    return () => {
      window.removeEventListener('focus', onFocus);
      stopWatchingServers();
      clearInterval(reconcile);
    };
  }, []);

  // Agent filters narrowing everything away is only an empty *agent* list. The
  // room view lists rooms, which are still there, and reports its own filters
  // being too narrow itself.
  const showFilterEmptyState =
    sidebarStore.grouping !== 'room' &&
    sidebarStore.hasActiveFilters &&
    sidebarStore.filteredLocations.length === 0;

  return (
    <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-3">
      <RoomStateDisclosure />
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
  const signedOut = switchRoomsStore.serversNotSignedIn;
  const failed = switchRoomsStore.serversThatFailedToLoad;

  // Being signed out is the whole explanation, so it is said on its own: the
  // memberships that "didn't load" are the same fact, and offering a retry for
  // something only a sign-in can fix sends the user in a circle.
  if (signedOut.length > 0) {
    return (
      <DisclosureBar>
        Sign in to {signedOut.map((s) => s.name).join(', ')} to see{' '}
        {signedOut.length === 1 ? 'its' : 'their'} rooms.{' '}
        <DisclosureAction onClick={() => navigate('server', { serverId: signedOut[0].id })}>
          Sign in
        </DisclosureAction>
      </DisclosureBar>
    );
  }

  const unknownMemberships = switchRoomsStore.agentsWithUnknownMembership;
  if (failed.length === 0 && unknownMemberships === 0) return null;

  const reasons: string[] = [];
  if (failed.length > 0) reasons.push(`couldn’t reach ${failed.map((s) => s.name).join(', ')}`);
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
