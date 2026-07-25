import { computed, makeAutoObservable, observable, reaction, runInAction } from 'mobx';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { type LocationStore } from '@renderer/features/locations/stores/location';
import type { LocationManagerStore } from '@renderer/features/locations/stores/location-manager';
import {
  isProvisioned,
  registeredSessionData,
  unregisteredSessionData,
  type SessionStore,
} from '@renderer/features/sessions/stores/session-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import type { Snapshottable } from '@renderer/lib/stores/snapshottable';
import type { AgentConnectionKind } from '@shared/core/agents/agent-connection';
import { representativeAgent } from '@shared/core/agents/agents';
import {
  AGENT_PROVIDER_IDS,
  isValidProviderId,
  type AgentProviderId,
} from '@shared/core/providers/agent-provider-registry';
import type { SidebarGrouping, SidebarSnapshot, SidebarSessionSortBy } from '@shared/view-state';

const AGENT_CONNECTION_KINDS: readonly AgentConnectionKind[] = ['local', 'remote'];

function isAgentConnectionKind(value: unknown): value is AgentConnectionKind {
  return value === 'local' || value === 'remote';
}

/** Room-key used for sessions not connected to any room (room-focused grouping). */
export const UNASSIGNED_ROOM_KEY = '__unassigned__';

/**
 * Horizontal indent added per tree depth, in px. The sidebar renders as a
 * filesystem-style tree: every row — agent, room, subagent or session — indents
 * by its depth times this step, so all entity types at the same depth share one
 * left edge regardless of type.
 */
export const SIDEBAR_DEPTH_STEP = 16;

/** Inline left-padding for a sidebar row at the given tree depth. */
export function depthIndent(depth: number): { paddingLeft: number } {
  return { paddingLeft: depth * SIDEBAR_DEPTH_STEP };
}

/** `collapsedGroupKeys` key for a room nested under an agent (agent-focused view). */
export function agentRoomGroupKey(locationId: string, roomKey: string): string {
  return `ar:${locationId}|${roomKey}`;
}

/** `collapsedGroupKeys` key for a room header in the room-focused view. */
export function roomViewGroupKey(roomKey: string): string {
  return `rv:${roomKey}`;
}

function parseSidebarGrouping(value: unknown): SidebarGrouping | undefined {
  return value === 'agent' || value === 'room' ? value : undefined;
}

function parseSidebarSessionSortBy(value: unknown): SidebarSessionSortBy | undefined {
  return value === 'created-at' || value === 'updated-at' ? value : undefined;
}

export type SessionSortKind = 'created' | 'updated';

export function sortKindFor(sortBy: SidebarSessionSortBy): SessionSortKind {
  return sortBy === 'created-at' ? 'created' : 'updated';
}

export function getSortInstant(session: SessionStore, kind: SessionSortKind): string | undefined {
  const reg = registeredSessionData(session);
  if (reg) {
    if (kind === 'created') return reg.createdAt;
    return reg.lastInteractedAt ?? reg.updatedAt;
  }
  const u = unregisteredSessionData(session);
  if (u) {
    if (kind === 'created') return u.createdAt;
    return u.lastInteractedAt;
  }
  return undefined;
}

export type SidebarRow =
  | { kind: 'location'; locationId: string }
  | { kind: 'session'; locationId: string; sessionId: string };

/**
 * Reorder `items` to honour a saved manual order. Items present in `stored`
 * appear in that order; items missing from it (newly arrived) keep their
 * incoming order and are placed first when `newFirst` is set (so fresh sessions
 * surface at the top) or last otherwise (so reordered rooms/agents stay put).
 */
export function applyManualOrder<T>(
  items: T[],
  getId: (item: T) => string,
  stored: string[] | undefined,
  newFirst: boolean
): T[] {
  if (!stored?.length) return items;
  const byId = new Map(items.map((item) => [getId(item), item] as const));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const id of stored) {
    const item = byId.get(id);
    if (item) {
      ordered.push(item);
      seen.add(id);
    }
  }
  const rest = items.filter((item) => !seen.has(getId(item)));
  return newFirst ? [...rest, ...ordered] : [...ordered, ...rest];
}

export class SidebarStore implements Snapshottable<SidebarSnapshot> {
  locationOrder: string[] = [];
  sessionOrderByLocation: Record<string, string[]> = {};
  /** Manual order of top-level rooms (room-focused grouping). */
  roomOrder: string[] = [];
  /** Manual order of items within a grouped-view sub-group, keyed by container id. */
  groupOrder: Record<string, string[]> = {};
  expandedLocationIds = observable.set<string>();
  sessionSortBy: SidebarSessionSortBy = 'created-at';
  grouping: SidebarGrouping = 'agent';
  expandedRoomKeys = observable.set<string>();
  /** Collapsed second-level group keys; absence means expanded (default open). */
  collapsedGroupKeys = observable.set<string>();
  /**
   * Optional sidebar filters. Each is additive and composes with the others (AND
   * across dimensions, OR within a dimension). Empty set / false = not filtering.
   * These filter only the grouped sidebar tree; pinned sessions and keyboard
   * session navigation stay unfiltered.
   */
  filterConnections = observable.set<AgentConnectionKind>();
  filterProviderIds = observable.set<AgentProviderId>();
  filterHasLiveSession = false;
  /**
   * Session whose row should scroll itself into view once it mounts. Set by the
   * deeplink handler (after revealing/expanding the tree) so the landed session
   * is centered in the sidebar; the row clears it after scrolling.
   */
  pendingScrollSessionId: string | null = null;

  constructor(private readonly locationManager: LocationManagerStore) {
    makeAutoObservable(this, {
      expandedLocationIds: false,
      expandedRoomKeys: false,
      collapsedGroupKeys: false,
      filterConnections: false,
      filterProviderIds: false,
      sidebarRows: computed,
      pinnedSidebarEntries: computed,
      filteredLocations: computed,
    });

    // Auto-expand a location when its session count goes from 0 to >0.
    const prevSessionCounts = new Map<string, number>();
    reaction(
      () => {
        const counts: [string, number][] = [];
        for (const [id, location] of this.locationManager.locations) {
          if (location.mountedLocation) {
            counts.push([id, location.mountedLocation.sessionManager.sessions.size]);
          }
        }
        return counts;
      },
      (counts) => {
        runInAction(() => {
          for (const [id, count] of counts) {
            const prev = prevSessionCounts.get(id) ?? 0;
            if (prev === 0 && count > 0) {
              this.ensureLocationExpanded(id);
            }
            prevSessionCounts.set(id, count);
          }
        });
      }
    );
  }

  /**
   * Whether a location belongs to the active server. The whole sidebar tree is
   * scoped to one server at a time: a location shows only when its agents are
   * linked to {@link switchServersStore.activeServerId}. Unregistered locations
   * (mid-onboarding, no agent row yet) always show so the user sees progress.
   * When no server is active, nothing is hidden.
   */
  isLocationInActiveScope(locationId: string): boolean {
    const activeServerId = switchServersStore.activeServerId;
    if (!activeServerId) return true;
    const location = this.locationManager.locations.get(locationId);
    if (location && location.state === 'unregistered') return true;
    return agentsStore.serverIdForLocation(locationId) === activeServerId;
  }

  get orderedLocations(): LocationStore[] {
    const all = Array.from(this.locationManager.locations.values()).filter((location) =>
      this.isLocationInActiveScope(location.id)
    );

    return [...all].sort((a, b) => {
      const ai = this.locationOrder.indexOf(a.id);
      const bi = this.locationOrder.indexOf(b.id);
      if (ai === -1 && bi === -1) return this.compareSidebarLocations(a, b);
      if (ai === -1) return -1;
      if (bi === -1) return 1;
      return ai - bi;
    });
  }

  /** The representative agent of a location (the agent shown on its sidebar row):
   * the first real (non-definition) agent, not a former subagent's row. */
  private parentAgent(locationId: string) {
    return representativeAgent(agentsStore.byLocation.get(locationId) ?? []);
  }

  /** Where a location runs — `remote` when it has an SSH host, else `local`. */
  locationConnection(locationId: string): AgentConnectionKind | null {
    const location = this.locationManager.locations.get(locationId)?.data;
    if (!location) return null;
    return location.sshHost !== null ? 'remote' : 'local';
  }

  /** A location's agent-type provider, or null when its agent is not yet known. */
  locationProviderId(locationId: string): AgentProviderId | null {
    return this.parentAgent(locationId)?.providerId ?? null;
  }

  /** Whether a location has at least one running (provisioned) session. */
  locationHasLiveSession(locationId: string): boolean {
    const location = this.locationManager.locations.get(locationId);
    if (!location?.mountedLocation) return false;
    for (const session of location.mountedLocation.sessionManager.sessions.values()) {
      if (isProvisioned(session)) return true;
    }
    return false;
  }

  /** Whether any filter dimension is currently narrowing the sidebar. */
  get hasActiveFilters(): boolean {
    return (
      this.filterConnections.size > 0 ||
      this.filterProviderIds.size > 0 ||
      this.filterHasLiveSession
    );
  }

  /** A location passes when it satisfies every active filter dimension. */
  private locationMatchesFilters(locationId: string): boolean {
    if (this.filterConnections.size > 0) {
      const connection = this.locationConnection(locationId);
      if (!connection || !this.filterConnections.has(connection)) return false;
    }
    if (this.filterProviderIds.size > 0) {
      const providerId = this.locationProviderId(locationId);
      if (!providerId || !this.filterProviderIds.has(providerId)) return false;
    }
    if (this.filterHasLiveSession && !this.locationHasLiveSession(locationId)) return false;
    return true;
  }

  /**
   * Server-scoped, ordered locations with the active sidebar filters applied. The
   * grouped sidebar trees render from this; when no filter is active it equals
   * {@link orderedLocations}.
   */
  get filteredLocations(): LocationStore[] {
    if (!this.hasActiveFilters) return this.orderedLocations;
    return this.orderedLocations.filter((location) => this.locationMatchesFilters(location.id));
  }

  /**
   * Run-location values present among the in-scope locations' agents, so the
   * filter menu only offers dimensions that actually match something.
   */
  get availableFilterConnections(): AgentConnectionKind[] {
    const present = new Set<AgentConnectionKind>();
    for (const location of this.orderedLocations) {
      const connection = this.locationConnection(location.id);
      if (connection) present.add(connection);
    }
    return AGENT_CONNECTION_KINDS.filter((kind) => present.has(kind));
  }

  /** Agent-type providers present among the in-scope locations' agents. */
  get availableFilterProviderIds(): AgentProviderId[] {
    const present = new Set<AgentProviderId>();
    for (const location of this.orderedLocations) {
      const providerId = this.locationProviderId(location.id);
      if (providerId) present.add(providerId);
    }
    return AGENT_PROVIDER_IDS.filter((id) => present.has(id));
  }

  get sidebarRows(): SidebarRow[] {
    const rows: SidebarRow[] = [];
    for (const location of this.orderedLocations) {
      const locationId = location.id;
      rows.push({ kind: 'location', locationId });
      if (this.expandedLocationIds.has(locationId) && location.mountedLocation) {
        const sessions = Array.from(
          location.mountedLocation.sessionManager.sessions.values()
        ).filter(
          (t) => t.state === 'unregistered' || !('archivedAt' in t.data && t.data.archivedAt)
        );
        const manualOrder = this.sessionOrderByLocation[locationId];
        const ordered = manualOrder?.length
          ? this.mergeSessionOrder(locationId, sessions)
          : this.sortSessionsForSidebar(sessions);
        for (const session of ordered) {
          if (session.data.isPinned) continue;
          rows.push({ kind: 'session', locationId, sessionId: session.data.id });
        }
      }
    }
    return rows;
  }

  /** Visible unpinned sessions in the same order they are rendered in the location tree. */
  get visibleSessionEntries(): { locationId: string; sessionId: string }[] {
    return this.sidebarRows
      .filter((row): row is Extract<SidebarRow, { kind: 'session' }> => row.kind === 'session')
      .map(({ locationId, sessionId }) => ({ locationId, sessionId }));
  }

  /** Flat list of pinned sessions (all mounted locations), same sort rules as location tree sessions. */
  get pinnedSidebarEntries(): { locationId: string; sessionId: string }[] {
    const pairs: { locationId: string; session: SessionStore }[] = [];
    for (const location of this.locationManager.locations.values()) {
      if (!location.mountedLocation) continue;
      if (!this.isLocationInActiveScope(location.id)) continue;
      const locationId = location.id;
      for (const session of location.mountedLocation.sessionManager.sessions.values()) {
        const visible =
          session.state === 'unregistered' ||
          !('archivedAt' in session.data && session.data.archivedAt);
        if (!visible || !session.data.isPinned) continue;
        pairs.push({ locationId, session });
      }
    }
    pairs.sort((a, b) => this.compareSidebarSessions(a.session, b.session));
    return pairs.map(({ locationId, session }) => ({ locationId, sessionId: session.data.id }));
  }

  /**
   * Visible unpinned session IDs for a location in sidebar order. Archived sessions are
   * and automation sessions are excluded. Independent of expand state so Next/Previous
   * Session navigation works even when the location is collapsed.
   */
  visibleSessionIdsForLocation(locationId: string): string[] {
    const location = this.locationManager.locations.get(locationId);
    if (!location?.mountedLocation) return [];
    const sessions = Array.from(location.mountedLocation.sessionManager.sessions.values()).filter(
      (t) =>
        !t.data.isPinned &&
        (t.state === 'unregistered' || !('archivedAt' in t.data && t.data.archivedAt))
    );
    const manualOrder = this.sessionOrderByLocation[locationId];
    const ordered = manualOrder?.length
      ? this.mergeSessionOrder(locationId, sessions)
      : this.sortSessionsForSidebar(sessions);
    return ordered.map((t) => t.data.id);
  }

  /**
   * Visible (non-archived, non-pinned) sessions for a location, sorted by the
   * current sidebar sort. Used by the grouped (agent/room) sidebar views, which
   * sort by recency rather than honouring manual drag order.
   */
  visibleSessionsForLocation(locationId: string): SessionStore[] {
    const location = this.locationManager.locations.get(locationId);
    if (!location?.mountedLocation) return [];
    const sessions = Array.from(location.mountedLocation.sessionManager.sessions.values()).filter(
      (t) =>
        !t.data.isPinned &&
        (t.state === 'unregistered' || !('archivedAt' in t.data && t.data.archivedAt))
    );
    return this.sortSessionsForSidebar(sessions);
  }

  get isEmpty(): boolean {
    return this.orderedLocations.length === 0;
  }

  get snapshot(): SidebarSnapshot {
    return {
      expandedLocationIds: [...this.expandedLocationIds],
      locationOrder: [...this.locationOrder],
      sessionOrderByLocation: { ...this.sessionOrderByLocation },
      sessionSortBy: this.sessionSortBy,
      grouping: this.grouping,
      expandedRoomKeys: [...this.expandedRoomKeys],
      collapsedGroupKeys: [...this.collapsedGroupKeys],
      roomOrder: [...this.roomOrder],
      groupOrder: { ...this.groupOrder },
      filterConnections: [...this.filterConnections],
      filterProviderIds: [...this.filterProviderIds],
      filterHasLiveSession: this.filterHasLiveSession,
    };
  }

  restoreSnapshot(snapshot: Partial<SidebarSnapshot>): void {
    if (snapshot.expandedLocationIds !== undefined) {
      this.expandedLocationIds.replace(snapshot.expandedLocationIds);
    }
    if (snapshot.locationOrder !== undefined) {
      this.locationOrder = [...snapshot.locationOrder];
    }
    if (snapshot.sessionOrderByLocation !== undefined) {
      this.sessionOrderByLocation = { ...snapshot.sessionOrderByLocation };
    }
    if (snapshot.sessionSortBy !== undefined) {
      const v = parseSidebarSessionSortBy(snapshot.sessionSortBy);
      if (v !== undefined) this.sessionSortBy = v;
    }
    const grouping = parseSidebarGrouping(snapshot.grouping);
    if (grouping !== undefined) this.grouping = grouping;
    if (snapshot.expandedRoomKeys !== undefined) {
      this.expandedRoomKeys.replace(snapshot.expandedRoomKeys);
    }
    if (snapshot.collapsedGroupKeys !== undefined) {
      this.collapsedGroupKeys.replace(snapshot.collapsedGroupKeys);
    }
    if (snapshot.roomOrder !== undefined) {
      this.roomOrder = [...snapshot.roomOrder];
    }
    if (snapshot.groupOrder !== undefined) {
      this.groupOrder = { ...snapshot.groupOrder };
    }
    if (snapshot.filterConnections !== undefined) {
      this.filterConnections.replace(snapshot.filterConnections.filter(isAgentConnectionKind));
    }
    if (snapshot.filterProviderIds !== undefined) {
      this.filterProviderIds.replace(snapshot.filterProviderIds.filter(isValidProviderId));
    }
    if (snapshot.filterHasLiveSession !== undefined) {
      this.filterHasLiveSession = snapshot.filterHasLiveSession;
    }
  }

  /** Called on first load when no snapshot exists — expand all known locations. */
  expandAllLocations(): void {
    for (const location of this.orderedLocations) {
      this.expandedLocationIds.add(location.id);
    }
  }

  toggleLocationExpanded(locationId: string): void {
    if (this.expandedLocationIds.has(locationId)) {
      this.expandedLocationIds.delete(locationId);
    } else {
      this.expandedLocationIds.add(locationId);
    }
  }

  ensureLocationExpanded(locationId: string): void {
    this.expandedLocationIds.add(locationId);
  }

  setSessionSortBy(sortBy: SidebarSessionSortBy): void {
    this.sessionSortBy = sortBy;
  }

  setGrouping(grouping: SidebarGrouping): void {
    this.grouping = grouping;
  }

  toggleFilterConnection(kind: AgentConnectionKind): void {
    if (this.filterConnections.has(kind)) this.filterConnections.delete(kind);
    else this.filterConnections.add(kind);
  }

  toggleFilterProviderId(id: AgentProviderId): void {
    if (this.filterProviderIds.has(id)) this.filterProviderIds.delete(id);
    else this.filterProviderIds.add(id);
  }

  setFilterHasLiveSession(value: boolean): void {
    this.filterHasLiveSession = value;
  }

  clearFilters(): void {
    this.filterConnections.clear();
    this.filterProviderIds.clear();
    this.filterHasLiveSession = false;
  }

  toggleRoomExpanded(key: string): void {
    if (this.expandedRoomKeys.has(key)) {
      this.expandedRoomKeys.delete(key);
    } else {
      this.expandedRoomKeys.add(key);
    }
  }

  ensureRoomExpanded(key: string): void {
    this.expandedRoomKeys.add(key);
  }

  /** Whether a second-level group (room-under-agent / agent-under-room) is open. */
  isGroupExpanded(key: string): boolean {
    return !this.collapsedGroupKeys.has(key);
  }

  toggleGroupExpanded(key: string): void {
    if (this.collapsedGroupKeys.has(key)) {
      this.collapsedGroupKeys.delete(key);
    } else {
      this.collapsedGroupKeys.add(key);
    }
  }

  ensureGroupExpanded(key: string): void {
    this.collapsedGroupKeys.delete(key);
  }

  /**
   * Reveal a session's row in the sidebar without changing the current grouping:
   * expand its agent and un-collapse the room group it sits in, covering both the
   * agent-focused and room-focused layouts. Used by the deeplink handler so the
   * targeted session is visible (and thus highlighted) wherever it lives.
   */
  revealSessionInRoom(locationId: string, roomId: string): void {
    this.ensureLocationExpanded(locationId);
    this.ensureGroupExpanded(agentRoomGroupKey(locationId, roomId));
    this.ensureGroupExpanded(roomViewGroupKey(roomId));
  }

  /** Ask the given session's sidebar row to scroll itself into view when it renders. */
  requestScrollToSession(sessionId: string): void {
    this.pendingScrollSessionId = sessionId;
  }

  /** Clear the pending scroll request (called by the row once it has scrolled). */
  clearPendingScroll(): void {
    this.pendingScrollSessionId = null;
  }

  /** Set the sort key and clear all manual session orders so the list fully re-sorts. */
  applySort(sortBy: SidebarSessionSortBy): void {
    this.sessionSortBy = sortBy;
    this.sessionOrderByLocation = {};
  }

  setLocationOrder(ids: string[]): void {
    this.locationOrder = ids;
  }

  setRoomOrder(ids: string[]): void {
    this.roomOrder = ids;
  }

  setGroupOrder(containerId: string, ids: string[]): void {
    this.groupOrder = { ...this.groupOrder, [containerId]: ids };
  }

  /** Top-level room keys reordered by the saved manual room order. */
  orderRoomKeys(roomKeys: string[]): string[] {
    return applyManualOrder(roomKeys, (key) => key, this.roomOrder, false);
  }

  /**
   * Items within a grouped-view sub-group reordered by its saved manual order.
   * `newFirst` surfaces freshly-arrived items at the top (used for sessions).
   */
  orderGroupItems<T>(
    containerId: string,
    items: T[],
    getId: (item: T) => string,
    newFirst: boolean
  ): T[] {
    return applyManualOrder(items, getId, this.groupOrder[containerId], newFirst);
  }

  mergeSessionOrder(locationId: string, sessions: SessionStore[]): SessionStore[] {
    const stored = this.sessionOrderByLocation[locationId] ?? [];
    const byId = new Map(sessions.map((t) => [t.data.id, t] as const));
    const seen = new Set<string>();
    const result: SessionStore[] = [];
    for (const id of stored) {
      const t = byId.get(id);
      if (t) {
        result.push(t);
        seen.add(id);
      }
    }
    // New sessions (not in the manual order) are sorted by date and prepended so
    // they always appear at the top rather than buried after manually-ordered sessions.
    const newSessions = sessions
      .filter((t) => !seen.has(t.data.id))
      .sort((a, b) => this.compareSidebarSessions(a, b));
    return [...newSessions, ...result];
  }

  setSessionOrder(locationId: string, orderedIds: string[]): void {
    this.sessionOrderByLocation = { ...this.sessionOrderByLocation, [locationId]: orderedIds };
  }

  private compareSidebarSessions(a: SessionStore, b: SessionStore): number {
    const kind = sortKindFor(this.sessionSortBy);
    const ia = getSortInstant(a, kind) ?? '';
    const ib = getSortInstant(b, kind) ?? '';
    const d = ib.localeCompare(ia);
    if (d !== 0) return d;
    return a.data.id.localeCompare(b.data.id);
  }

  private compareSidebarLocations(a: LocationStore, b: LocationStore): number {
    const d = b.createdAt.localeCompare(a.createdAt);
    if (d !== 0) return d;
    return a.id.localeCompare(b.id);
  }

  private sortSessionsForSidebar(sessions: SessionStore[]): SessionStore[] {
    return [...sessions].sort((a, b) => this.compareSidebarSessions(a, b));
  }
}
