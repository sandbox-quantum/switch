import type { AgentConnectionKind } from '@shared/core/agents/agent-connection';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

export type LocationViewSnapshot = {
  activeView: string;
  sessionViewTab: 'active' | 'archived';
};

export type NavigationSnapshot = {
  currentViewId: string;
  viewParams: Record<string, unknown>;
};

export type SidebarSessionSortBy = 'created-at' | 'updated-at';

/** How the room-focused sidebar orders rooms. Rooms are places rather than
 * work, so they sort by name by default; `updated-at` means the most recent
 * session activity in the room. */
export type SidebarRoomSortBy = 'name' | 'created-at' | 'updated-at';

/** How the sidebar groups sessions: by agent (agent → room → sessions) or by
 * room (room → agents → sessions). */
export type SidebarGrouping = 'agent' | 'room';

/** Persisted sidebar UI state; fields may be absent in older DB blobs. */
export type SidebarSnapshot = {
  expandedLocationIds?: string[];
  locationOrder?: string[];
  sessionOrderByLocation?: Record<string, string[]>;
  sessionSortBy?: SidebarSessionSortBy;
  grouping?: SidebarGrouping;
  /** Expanded room keys in room-focused grouping (room id, or '__unassigned__'). */
  expandedRoomKeys?: string[];
  /**
   * Collapsed sub-group keys for the second level of the grouped views — rooms
   * under an agent (agent-focused) and agents under a room (room-focused).
   * Stored as collapsed (not expanded) so these levels default to open.
   */
  collapsedGroupKeys?: string[];
  /** Manual order of the top-level rooms in the room-focused grouping. */
  roomOrder?: string[];
  /**
   * Manual order of items within a grouped-view sub-group, keyed by a container
   * id (e.g. an agent's room group, or a room's per-agent session group). Used by
   * the grouped views' drag-to-reorder; absent groups fall back to the default sort.
   */
  groupOrder?: Record<string, string[]>;
  /**
   * Optional left-sidebar filters. Each dimension is additive and composes with
   * the others (AND across dimensions, OR within one). An empty array / false
   * means that dimension is not filtering.
   */
  filterConnections?: AgentConnectionKind[];
  filterProviderIds?: AgentProviderId[];
  filterHasLiveSession?: boolean;
  /**
   * Room-focused filters, kept apart from the agent ones above: the two views
   * filter different things, so a dimension set in one must not silently narrow
   * the other. `filterBridgeTypes` holds bridge types (`slack`, …) plus the
   * sentinel {@link UNBRIDGED_FILTER_VALUE} for rooms with no messaging app.
   */
  roomSortBy?: SidebarRoomSortBy;
  filterBridgeTypes?: string[];
  filterRoomHasLiveSession?: boolean;
};

/** `filterBridgeTypes` entry standing for "no messaging app", which has no
 * bridge type of its own but is a thing you want to filter for. */
export const UNBRIDGED_FILTER_VALUE = '__unbridged__';
