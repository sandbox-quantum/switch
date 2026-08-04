import { makeAutoObservable, runInAction } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import type {
  RemoteAgentRoom,
  RemoteRoomSummary,
} from '@shared/core/switch-servers/switch-servers';
import { UNBRIDGED_FILTER_VALUE } from '@shared/view-state';
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
   * room you create in switchdash is visible the moment it exists rather than
   * only once an agent joins it. */
  private readonly ownedRoomsByServer = new Map<string, RemoteRoomSummary[]>();
  /** Server id → every active room on it. Listed in full for a server this
   * install manages; elsewhere it backs lookups rather than the room list. */
  private readonly allRoomsByServer = new Map<string, RemoteRoomSummary[]>();
  /** Keys with an in-flight fetch. */
  readonly loading = new Set<string>();
  /** Last error per key, if the most recent fetch failed. */
  readonly errors = new Map<string, string>();

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

  /** Display name of the server a room belongs to, for the room titlebar's
   * breadcrumb. Null while rooms are still loading. */
  roomServerName(roomId: string): string | null {
    const serverId = this.roomServerById.get(roomId);
    if (!serverId) return null;
    return switchServersStore.servers.find((s) => s.id === serverId)?.name ?? null;
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
    const listed = serverIds.flatMap((serverId) => {
      const managed = switchServersStore.servers.find((s) => s.id === serverId)?.managed ?? false;
      return (
        (managed ? this.allRoomsByServer.get(serverId) : this.ownedRoomsByServer.get(serverId)) ??
        []
      );
    });
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
   * Refresh the room id → name map from every connected server's room list.
   * Best-effort: a server that fails to respond is skipped (its rooms keep
   * their last-known names, or fall back to a short id in the UI).
   */
  async loadRoomNames(): Promise<void> {
    const connected = switchServersStore.servers.filter((s) =>
      switchServersStore.isConnected(s.id)
    );
    await Promise.all(
      connected.map(async (server) => {
        try {
          const rooms = await rpc.switchServers.listRemoteRooms(server.id);
          // Ownership is per server: the same person is a different user row on
          // each gateway, so match against that server's signed-in identity.
          const signedInUserId = switchServersStore.statusFor(server.id)?.user?.id ?? null;
          runInAction(() => {
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
        } catch {
          // skip this server; names stay best-effort
        }
      })
    );
  }

  /** Cached membership, or undefined if never fetched. */
  roomsFor(serverId: string, switchAgentId: string): RemoteAgentRoom[] | undefined {
    return this.roomsByAgent.get(key(serverId, switchAgentId));
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
        this.errors.set(k, cause instanceof Error ? cause.message : String(cause));
      });
      return null;
    } finally {
      runInAction(() => {
        this.loading.delete(k);
      });
    }
  }

  /** Re-fetch every cached entry (e.g. on window focus). */
  async refreshAll(): Promise<void> {
    const keys = Array.from(this.roomsByAgent.keys());
    await Promise.all(
      keys.map((k) => {
        const [serverId, switchAgentId] = k.split(':');
        return this.fetchAgentRooms(serverId, switchAgentId, { force: true });
      })
    );
  }
}

export const switchRoomsStore = new SwitchRoomsStore();
