import { observer } from 'mobx-react-lite';
import { Fragment, useEffect } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import type { LocationStore } from '@renderer/features/locations/stores/location';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import type { SessionStore } from '@renderer/features/sessions/stores/session-store';
import { switchRoomsStore as roomConnectionsStore } from '@renderer/features/switch-rooms/switch-rooms-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import type { Agent } from '@shared/core/agents/agents';
import { SidebarAgentItem, agentExpandKey } from './agent-item';
import { SidebarSessionItem } from './session-item';
import {
  groupByRoom,
  openRoomInGateway,
  openRoomView,
  openRoomInMessagingApp,
  RoomRow,
  roomLabel,
} from './sidebar-room-grouping';
import { agentRoomGroupKey, roomViewGroupKey, UNASSIGNED_ROOM_KEY } from './sidebar-store';

/** An agent paired with its (mounted) location, for the flat sidebar list. */
type AgentEntry = { agent: Agent; location: LocationStore };

/**
 * The flat list of agents in the active-server scope, newest first. switchdash
 * shows agents as a flat list — not grouped by directory (CHOO-1440).
 */
function scopedAgents(): AgentEntry[] {
  const entries: AgentEntry[] = [];
  for (const location of sidebarStore.filteredLocations) {
    for (const agent of agentsStore.byLocation.get(location.id) ?? []) {
      entries.push({ agent, location });
    }
  }
  return entries.sort(
    (a, b) =>
      b.agent.createdAt.localeCompare(a.agent.createdAt) || a.agent.name.localeCompare(b.agent.name)
  );
}

/**
 * An agent's visible sessions: the location's sessions it owns. Sessions are
 * paired to their agent by `agent_id` — the authoritative link — not by matching
 * a name frozen into the session's config against the agent's definition. A
 * session whose owning agent no longer matches by name is still shown under its
 * agent instead of silently vanishing (CHOO-1440).
 */
function agentSessions(entry: AgentEntry): SessionStore[] {
  const all = sidebarStore.visibleSessionsForLocation(entry.location.id);
  return all.filter(
    (session) => 'agentId' in session.data && session.data.agentId === entry.agent.id
  );
}

export const SidebarGroupedList = observer(function SidebarGroupedList() {
  // Live session→room connections + room names live on the server; pull them
  // once on mount and refresh names on focus so headers show names not ids.
  useEffect(() => {
    roomConnectionsStore.ensureLoaded();
    void agentsStore.load();
    void hostReachabilityStore.hydrate();
    void switchServersStore.init().then(() => switchRoomsStore.loadRoomNames());
    const onFocus = () => {
      void agentsStore.load();
      void switchRoomsStore.loadRoomNames();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const showFilterEmptyState =
    sidebarStore.hasActiveFilters && sidebarStore.filteredLocations.length === 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-3">
      {showFilterEmptyState ? (
        <p className="px-2 py-3 text-xs text-foreground-muted">No agents match filters</p>
      ) : sidebarStore.grouping === 'room' ? (
        <RoomFocusedTree />
      ) : (
        <AgentFocusedTree />
      )}
    </div>
  );
});

/** Render an agent's sessions grouped by room, under the agent row. */
const AgentSessions = observer(function AgentSessions({
  agentId,
  locationId,
  sessions,
  depth,
}: {
  agentId: string;
  locationId: string;
  sessions: SessionStore[];
  depth: number;
}) {
  return (
    <>
      {groupByRoom(sessions).map(([roomKey, roomSessions]) => {
        // Sessions with no room sit directly under the agent, no room header.
        if (roomKey === UNASSIGNED_ROOM_KEY) {
          return roomSessions.map((session) => (
            <SidebarSessionItem
              key={session.data.id}
              locationId={locationId}
              sessionId={session.data.id}
              depth={depth}
            />
          ));
        }
        const groupKey = agentRoomGroupKey(agentId, roomKey);
        const roomExpanded = sidebarStore.isGroupExpanded(groupKey);
        return (
          <div key={roomKey}>
            <RoomRow
              label={roomLabel(roomKey)}
              count={roomSessions.length}
              expanded={roomExpanded}
              depth={depth}
              bridgeType={switchRoomsStore.roomBridgeTypeById(roomKey)}
              onToggle={() => sidebarStore.toggleGroupExpanded(groupKey)}
              onSelect={roomKey === UNASSIGNED_ROOM_KEY ? null : () => openRoomView(roomKey)}
              onOpenGateway={() => openRoomInGateway(roomKey)}
              onOpenChannel={
                switchRoomsStore.roomChannelUrl(roomKey)
                  ? () => openRoomInMessagingApp(roomKey)
                  : null
              }
            />
            {roomExpanded &&
              roomSessions.map((session) => (
                <SidebarSessionItem
                  key={session.data.id}
                  locationId={locationId}
                  sessionId={session.data.id}
                  depth={depth + 1}
                />
              ))}
          </div>
        );
      })}
    </>
  );
});

const AgentFocusedTree = observer(function AgentFocusedTree() {
  const agents = scopedAgents();
  return (
    <>
      {agents.map((entry) => {
        const expanded = sidebarStore.isGroupExpanded(agentExpandKey(entry.agent.id));
        return (
          <div key={entry.agent.id}>
            <SidebarAgentItem agent={entry.agent} depth={0} />
            {expanded && (
              <AgentSessions
                agentId={entry.agent.id}
                locationId={entry.agent.locationId}
                sessions={agentSessions(entry)}
                depth={1}
              />
            )}
          </div>
        );
      })}
    </>
  );
});

const RoomFocusedTree = observer(function RoomFocusedTree() {
  // Tag every visible session with the agent it belongs to, then group by room.
  const bySession = new Map<string, AgentEntry>();
  const allSessions: SessionStore[] = [];
  for (const entry of scopedAgents()) {
    for (const session of agentSessions(entry)) {
      bySession.set(session.data.id, entry);
      allSessions.push(session);
    }
  }

  return (
    <>
      {groupByRoom(allSessions).map(([roomKey, roomSessions]) => {
        const roomViewKey = roomViewGroupKey(roomKey);
        const expanded = sidebarStore.isGroupExpanded(roomViewKey);
        // Agents that have a session in this room, in first-seen order.
        const seen = new Set<string>();
        const agentsInRoom: AgentEntry[] = [];
        for (const session of roomSessions) {
          const entry = bySession.get(session.data.id);
          if (entry && !seen.has(entry.agent.id)) {
            seen.add(entry.agent.id);
            agentsInRoom.push(entry);
          }
        }
        return (
          <div key={roomKey}>
            <RoomRow
              label={roomLabel(roomKey)}
              count={roomSessions.length}
              expanded={expanded}
              depth={0}
              bridgeType={switchRoomsStore.roomBridgeTypeById(roomKey)}
              onToggle={() => sidebarStore.toggleGroupExpanded(roomViewKey)}
              onSelect={roomKey === UNASSIGNED_ROOM_KEY ? null : () => openRoomView(roomKey)}
              onOpenGateway={() => openRoomInGateway(roomKey)}
              onOpenChannel={
                switchRoomsStore.roomChannelUrl(roomKey)
                  ? () => openRoomInMessagingApp(roomKey)
                  : null
              }
            />
            {expanded &&
              agentsInRoom.map((entry) => {
                const agentSessionsHere = roomSessions.filter(
                  (session) => bySession.get(session.data.id)?.agent.id === entry.agent.id
                );
                return (
                  <Fragment key={entry.agent.id}>
                    <SidebarAgentItem agent={entry.agent} depth={1} />
                    {agentSessionsHere.map((session) => (
                      <SidebarSessionItem
                        key={session.data.id}
                        locationId={entry.agent.locationId}
                        sessionId={session.data.id}
                        depth={2}
                      />
                    ))}
                  </Fragment>
                );
              })}
          </div>
        );
      })}
    </>
  );
});
