import { makeAutoObservable, runInAction } from 'mobx';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type {
  RemoteAgentRoom,
  RemoteRoomSummary,
} from '@shared/core/switch-servers/switch-servers';
import { UNBRIDGED_FILTER_VALUE } from '@shared/view-state';
import { serverAvailability } from './server-availability';
import { switchServersStore } from './switch-servers-store';

/** Cache key for an agent's room membership: server + Switch agent id. */
function key(serverId: string, switchAgentId: string): string {
  return `${serverId}:${switchAgentId}`;
}

/**
 * Renderer cache of per-agent room membership, queried live from the gateway
 * (the server is the source of truth — we do not mirror rooms into SQLite).
 * Entries are cached in memory and re-fetched on demand or on window focus, so
 * the "connect to room" picker and the room-focused sidebar grouping render the
 * last-known set instantly while a refresh runs.
 */
export class SwitchRoomsStore {
  /** Membership per `${serverId}:${switchAgentId}`. */
  private readonly roomsByAgent = new Map<string, RemoteAgentRoom[]>();
  /** Room id → display name, aggregated across connected servers (room ids are
   * globally unique UUIDs, so a flat map is safe). Drives sidebar room headers. */
  private readonly roomNames = new Map<string, string>();
  /** Room id → owning server id, so a room can be linked to its gateway web app. */
  private readonly roomServerById = new Map<string, string>();
  /** Room id → bridge type (`slack`, `mattermost`, …) when the room is bridged
   * to an external platform, so the sidebar can show that platform's icon. */
  private readonly bridgeTypeByRoom = new Map<string, string>();
  /** Room id → native deeplink that opens its channel in the messaging app's
   * desktop client, when the room is bridged and the link could be built. */
  private readonly channelUrlByRoom = new Map<string, string>();
  /** Server id → the active rooms on that server owned by the signed-in user.
   * The sidebar lists these even when no session is connected to them, so a
   * room you create in Switch Console is visible the moment it exists rather than
   * only once an agent joins it. */
  private readonly ownedRoomsByServer = new Map<string, RemoteRoomSummary[]>();
  /** Server id → every active room on it. Listed in full for a server this
   * install manages; elsewhere it backs lookups rather than the room list. */
  private readonly allRoomsByServer = new Map<string, RemoteRoomSummary[]>();
  /** Keys with an in-flight fetch. */
  readonly loading = new Set<string>();
  /** Last error per key, if the most recent fetch failed. */
  readonly errors = new Map<string, string>();
  /** Server id → why its room list could not be read, if the last try failed. */
  private readonly roomListErrors = new Map<string, string>();
  /** Servers that were not connected when the room list was last refreshed, so
   * their rooms were never asked for at all. */
  private unreachableServerIds: string[] = [];
  /** The agents whose membership this store is responsible for keeping current.
   * Recorded on {@link ensureMembershipsFor} so a refresh re-reads the current
   * set rather than only the keys that happen to be cached — an agent created
   * after the sidebar mounted is otherwise never fetched. */
  private trackedIdentities: { serverId: string; switchAgentId: string }[] = [];

  constructor() {
    makeAutoObservable(this);
  }

  /** Display name for a room id, or null if not yet known. */
  roomNameById(roomId: string): string | null {
    return this.roomNames.get(roomId) ?? null;
  }

  /** Bridge type (`slack`, `mattermost`, …) for a room, or null if it isn't
   * bridged to an external platform (or its rooms haven't loaded yet). */
  roomBridgeTypeById(roomId: string): string | null {
    return this.bridgeTypeByRoom.get(roomId) ?? null;
  }

  /** Native deeplink that opens the room's channel in the messaging app's
   * desktop client, or null if the room isn't bridged / the link is unknown. */
  roomChannelUrl(roomId: string): string | null {
    return this.channelUrlByRoom.get(roomId) ?? null;
  }

  /** Id of the server a room belongs to, or null if not yet loaded. The room
   * view needs it to resolve that server's Mattermost session. */
  roomServerId(roomId: string): string | null {
    return this.roomServerById.get(roomId) ?? null;
  }

  /**
   * URL of a room's detail page in the gateway web app, or null if the room's
   * owning server isn't known yet (names/servers are loaded by loadRoomNames).
   */
  gatewayRoomUrl(roomId: string): string | null {
    const serverId = this.roomServerById.get(roomId);
    if (!serverId) return null;
    const server = switchServersStore.servers.find((s) => s.id === serverId);
    if (!server) return null;
    const base = server.gatewayUrl.replace(/\/+$/, '');
    return `${base}/rooms/${roomId}`;
  }

  /**
   * URL of an agent's detail page in the gateway web app, or null if the server
   * isn't known. Unlike rooms, the caller supplies the server id directly (an
   * agent carries its owning server on its config).
   */
  gatewayAgentUrl(serverId: string, switchAgentId: string): string | null {
    const server = switchServersStore.servers.find((s) => s.id === serverId);
    if (!server) return null;
    const base = server.gatewayUrl.replace(/\/+$/, '');
    return `${base}/agents/${switchAgentId}`;
  }

  /**
   * The rooms the sidebar lists on their own account, before membership is
   * considered — the ones that are there because of what they are, not because
   * one of this install's agents is in them.
   *
   * On a server this install manages, that is **every** room: you run the
   * deployment, so there is nothing on it you should have to go elsewhere to
   * see. On any other server it is the rooms you created, which would otherwise
   * disappear the moment you made one and put no agent in it.
   *
   * The sidebar tree shows one server at a time, so these follow the same scope
   * rule as locations do — including that no active server hides nothing.
   */
  get listedRoomsInActiveScope(): RemoteRoomSummary[] {
    const activeServerId = switchServersStore.activeServerId;
    const serverIds = activeServerId
      ? [activeServerId]
      : [...new Set([...this.allRoomsByServer.keys(), ...this.ownedRoomsByServer.keys()])];
    const listed = serverIds.flatMap((serverId) => this.listedRoomsOnServer(serverId));
    return listed.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The rooms one server contributes to the lists above, under the same scope
   * rule. Named separately so a page about a single server asks for that
   * server rather than for whichever one happens to be active.
   */
  listedRoomsOnServer(serverId: string): RemoteRoomSummary[] {
    const managed = switchServersStore.servers.find((s) => s.id === serverId)?.managed ?? false;
    return (
      (managed ? this.allRoomsByServer.get(serverId) : this.ownedRoomsByServer.get(serverId)) ?? []
    );
  }

  /**
   * Every active room the signed-in user can see on a server — what the gateway
   * returned, which is already scoped to rooms they may read.
   *
   * Wider than {@link listedRoomsOnServer} on purpose. A standing list has to
   * earn its place on screen, so the sidebar shows only rooms with a claim on
   * you; a picker is a list you went looking for, and one that hides rooms you
   * have every right to join cannot be searched into showing them.
   */
  readableRoomsOnServer(serverId: string): RemoteRoomSummary[] {
    return this.allRoomsByServer.get(serverId) ?? [];
  }

  /**
   * The same listed rooms as {@link listedRoomsInActiveScope}, but across every
   * server rather than the active one.
   *
   * Search is deliberately not scoped to the active server: you search precisely
   * because you do not know where a thing is, and a result set silently limited
   * to the server you happen to be looking at cannot answer that. Navigating to
   * one of these switches the active server (see `scopeToRoomServer`), so the
   * sidebar follows you there rather than filtering the room back out.
   */
  get listedRoomsOnAllServers(): RemoteRoomSummary[] {
    const serverIds = [
      ...new Set([...this.allRoomsByServer.keys(), ...this.ownedRoomsByServer.keys()]),
    ];
    const listed = serverIds.flatMap((serverId) => this.listedRoomsOnServer(serverId));
    return listed.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The messaging-app values worth offering as a room filter on the active
   * server: the bridge types actually in use, plus the unbridged sentinel when
   * some room has no messaging app. Offering a platform with no rooms behind it
   * would be a filter that can only ever empty the list.
   */
  get bridgeFilterValuesInActiveScope(): string[] {
    const present = new Set<string>();
    for (const room of this.listedRoomsInActiveScope) {
      present.add(room.bridgeType ?? UNBRIDGED_FILTER_VALUE);
    }
    // The sentinel sorts last so the real platforms lead the menu.
    return [...present].sort((a, b) => {
      if (a === UNBRIDGED_FILTER_VALUE) return 1;
      if (b === UNBRIDGED_FILTER_VALUE) return -1;
      return a.localeCompare(b);
    });
  }

  /** Full detail for a room, when its server's room list has been loaded. */
  roomSummaryById(roomId: string): RemoteRoomSummary | null {
    const serverId = this.roomServerById.get(roomId);
    if (!serverId) return null;
    return this.allRoomsByServer.get(serverId)?.find((room) => room.id === roomId) ?? null;
  }

  /**
   * Whether the signed-in user may delete a room: they own it, or they are an
   * admin on its server.
   *
   * This mirrors the gateway's own rule so the action is not offered where it
   * would only be refused. It is not the check that protects anything — the
   * server's is — and where ownership is unknown the answer is no, since
   * showing a delete that fails is worse than not showing one.
   */
  canDeleteRoom(serverId: string, room: RemoteRoomSummary): boolean {
    const user = switchServersStore.statusFor(serverId)?.user ?? null;
    if (!user) return false;
    return room.ownerId === user.id || user.role === 'admin';
  }

  /**
   * Delete a room on its server, then re-read what is left.
   *
   * Throws on refusal rather than reporting a boolean: the caller is a
   * confirmation dialog, and a delete that quietly did nothing would leave the
   * room on screen with no account of why.
   */
  async deleteRoom(serverId: string, roomId: string): Promise<void> {
    await rpc.switchServers.deleteRoom({ serverId, roomId });
    await this.refreshRoomState();
  }

  /**
   * The servers whose state is on screen: the active one, or all of them when
   * none is active (the same scope rule the room and location lists follow).
   *
   * Each server is its own world — its own rooms, its own agents, its own
   * connection. Reading or reporting on one you are not looking at is both
   * wasted work and, worse, someone else's problem presented as yours.
   */
  private get serverIdsInScope(): string[] {
    const activeServerId = switchServersStore.activeServerId;
    if (activeServerId) return [activeServerId];
    return switchServersStore.servers.map((s) => s.id);
  }

  /**
   * Refresh the room catalogue for the servers on screen.
   *
   * A server that cannot be read keeps its last-known rooms rather than losing
   * them, but the failure is recorded in {@link roomListErrors} instead of being
   * swallowed: last-known data rendered as if it were current is the one outcome
   * worse than showing nothing.
   */
  async loadRoomNames(): Promise<void> {
    await this.loadRoomsFrom(this.serverIdsInScope);
  }

  /**
   * Refresh the room catalogue for **every** server.
   *
   * Only for cross-server search, which is deliberately not scoped — you search
   * because you do not know where a thing is. Everything else loads the servers
   * it is actually showing.
   */
  async loadRoomsOnAllServers(): Promise<void> {
    await this.loadRoomsFrom(switchServersStore.servers.map((s) => s.id));
  }

  private async loadRoomsFrom(serverIds: string[]): Promise<void> {
    const servers = switchServersStore.servers.filter((s) => serverIds.includes(s.id));
    const connected = servers.filter((s) => switchServersStore.isConnected(s.id));
    runInAction(() => {
      // Not being connected is not a failure — there is simply nothing to ask
      // right now — but the rooms on that server are equally unknown, and the
      // sidebar has to be able to say so.
      const asked = new Set(serverIds);
      this.unreachableServerIds = [
        ...this.unreachableServerIds.filter((id) => !asked.has(id)),
        ...servers.filter((s) => !switchServersStore.isConnected(s.id)).map((s) => s.id),
      ];
    });
    await Promise.all(
      connected.map(async (server) => {
        try {
          const rooms = await rpc.switchServers.listRemoteRooms(server.id);
          // Ownership is per server: the same person is a different user row on
          // each gateway, so match against that server's signed-in identity.
          const signedInUserId = switchServersStore.statusFor(server.id)?.user?.id ?? null;
          runInAction(() => {
            this.roomListErrors.delete(server.id);
            for (const room of rooms) {
              this.roomNames.set(room.id, room.name);
              this.roomServerById.set(room.id, server.id);
              if (room.bridgeType) this.bridgeTypeByRoom.set(room.id, room.bridgeType);
              else this.bridgeTypeByRoom.delete(room.id);
              if (room.externalChannelUrl)
                this.channelUrlByRoom.set(room.id, room.externalChannelUrl);
              else this.channelUrlByRoom.delete(room.id);
            }
            const active = rooms.filter((r) => !r.archived);
            this.allRoomsByServer.set(server.id, active);
            this.ownedRoomsByServer.set(
              server.id,
              signedInUserId ? active.filter((r) => r.ownerId === signedInUserId) : []
            );
          });
        } catch (cause) {
          runInAction(() => {
            this.roomListErrors.set(
              server.id,
              failureText(cause, `Could not load the rooms on ${server.name}.`)
            );
          });
        }
      })
    );
  }

  /**
   * Whether a room's name is missing because Switch Console is not signed in to its
   * server, rather than because the load has not finished.
   *
   * The room itself is known — an agent's membership put it there — so the row
   * has to say something. Which of the two it is decides whether the user is
   * being asked to wait or to act.
   */
  roomNameBlockedBySignIn(roomId: string): boolean {
    const serverId = this.roomServerById.get(roomId) ?? switchServersStore.activeServerId;
    if (!serverId) return false;
    return serverAvailability(serverId) === 'signed-out';
  }

  /**
   * Servers on screen whose room list was asked for and failed.
   *
   * Distinct from {@link serversNotSignedIn}: this is a fault, it may be
   * transient, and retrying is a sensible thing to offer.
   */
  get serversThatFailedToLoad(): { id: string; name: string }[] {
    return this.namedServersInScope([...this.roomListErrors.keys()]);
  }

  /**
   * Servers on screen that were never asked because Switch Console is not signed in
   * to them.
   *
   * Not a fault and not retryable — the user has to sign in. Reporting it as a
   * failure with a retry button offers an action that cannot work.
   */
  get serversNotSignedIn(): { id: string; name: string }[] {
    return this.namedServersInScope(
      this.unreachableServerIds.filter((id) => serverAvailability(id) === 'signed-out')
    );
  }

  private namedServersInScope(serverIds: string[]): { id: string; name: string }[] {
    const inScope = new Set(this.serverIdsInScope);
    return [...new Set(serverIds)]
      .filter((id) => inScope.has(id))
      .map((id) => ({
        id,
        name: switchServersStore.servers.find((s) => s.id === id)?.name ?? id,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Agents whose room membership is not known: the fetch failed, or has not run.
   *
   * Their rooms cannot list them, so a room can look emptier than it is. That is
   * indistinguishable from a genuinely empty room unless it is said out loud.
   */
  get agentsWithUnknownMembership(): number {
    return this.trackedIdentities.filter(
      ({ serverId, switchAgentId }) =>
        this.roomsByAgent.get(key(serverId, switchAgentId)) === undefined &&
        !this.isLoading(serverId, switchAgentId)
    ).length;
  }

  /** Cached membership, or undefined if never fetched. */
  roomsFor(serverId: string, switchAgentId: string): RemoteAgentRoom[] | undefined {
    return this.roomsByAgent.get(key(serverId, switchAgentId));
  }

  /**
   * Room id → the Switch agent ids of this install's agents that belong to it.
   *
   * The gateway answers membership per agent, so the room-keyed view has to be
   * derived. Deriving it **here, once** rather than in each tree at render time
   * is what makes a room's member list and its member count the same read: any
   * view that wants either reads this, so the two cannot disagree.
   *
   * Scope is deliberate. This install can only act on its own agents, so those
   * are the only members the sidebar can draw. A room's full membership, agents
   * on other installs included, is the server's own count and is listed on the
   * Your Rooms page.
   */
  get localMemberIdsByRoom(): Map<string, string[]> {
    const byRoom = new Map<string, string[]>();
    for (const [cacheKey, memberships] of this.roomsByAgent) {
      const switchAgentId = cacheKey.slice(cacheKey.indexOf(':') + 1);
      for (const membership of memberships) {
        if (membership.archived) continue;
        const members = byRoom.get(membership.roomId);
        if (members) members.push(switchAgentId);
        else byRoom.set(membership.roomId, [switchAgentId]);
      }
    }
    return byRoom;
  }

  /** The Switch agent ids of this install's agents in a room. */
  localMemberIds(roomId: string): string[] {
    return this.localMemberIdsByRoom.get(roomId) ?? [];
  }

  /**
   * Re-read every fact the sidebar's room state is built from: the room lists
   * and the membership of every tracked agent.
   *
   * The single door for "something changed, the view must catch up". Mutations
   * call this instead of picking their own subset of refreshes, which is how a
   * write ends up landing in one cache and missing another.
   */
  async refreshRoomState(): Promise<void> {
    await Promise.all([
      this.loadRoomNames(),
      this.ensureMembershipsFor(this.trackedIdentities, { force: true }),
    ]);
  }

  /**
   * Load membership for several agents at once. The room-grouped sidebar lists
   * an agent under every room it belongs to, not only the rooms it happens to
   * have a session in, so it needs the whole set up front rather than one
   * agent's at a time.
   */
  async ensureMembershipsFor(
    agents: { serverId: string; switchAgentId: string }[],
    options: { force?: boolean } = {}
  ): Promise<void> {
    runInAction(() => {
      this.trackedIdentities = agents;
    });
    await Promise.all(
      agents.map((a) => this.fetchAgentRooms(a.serverId, a.switchAgentId, options))
    );
  }

  isLoading(serverId: string, switchAgentId: string): boolean {
    return this.loading.has(key(serverId, switchAgentId));
  }

  errorFor(serverId: string, switchAgentId: string): string | null {
    return this.errors.get(key(serverId, switchAgentId)) ?? null;
  }

  /**
   * Fetch (or return cached) membership for an agent. Pass `force` to bypass the
   * cache. Returns the membership, or null if the fetch failed.
   */
  async fetchAgentRooms(
    serverId: string,
    switchAgentId: string,
    options: { force?: boolean } = {}
  ): Promise<RemoteAgentRoom[] | null> {
    const k = key(serverId, switchAgentId);
    const cached = this.roomsByAgent.get(k);
    if (cached && !options.force) return cached;

    runInAction(() => {
      this.loading.add(k);
      this.errors.delete(k);
    });
    try {
      const rooms = await rpc.switchServers.listAgentRooms({ serverId, agentId: switchAgentId });
      runInAction(() => {
        this.roomsByAgent.set(k, rooms);
      });
      return rooms;
    } catch (cause) {
      runInAction(() => {
        this.errors.set(k, failureText(cause, 'Could not load the rooms this agent belongs to.'));
      });
      return null;
    } finally {
      runInAction(() => {
        this.loading.delete(k);
      });
    }
  }
}

export const switchRoomsStore = new SwitchRoomsStore();
