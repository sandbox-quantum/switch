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

/** How the sidebar groups sessions: by agent (agent → room → sessions) or by
 * room (room → agents → sessions). */
export type SidebarGrouping = 'agent' | 'room';

/** Persisted sidebar UI state; fields may be absent in older DB blobs. */
export type SidebarSnapshot = {
  expandedProjectIds?: string[];
  projectOrder?: string[];
  sessionOrderByProject?: Record<string, string[]>;
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
};
