import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { observer } from 'mobx-react-lite';
import { Fragment, useEffect } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import type { SessionStore } from '@renderer/features/sessions/stores/session-store';
import { switchRoomsStore as roomConnectionsStore } from '@renderer/features/switch-rooms/switch-rooms-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { SidebarLocationItem } from './location-item';
import { SidebarSessionItem } from './session-item';
import { makeDndId, SortableBranch, SortableLeaf, useSidebarDnd } from './sidebar-dnd';
import {
  groupByRoom,
  isSubagentSession,
  openRoomInGateway,
  openRoomInMessagingApp,
  RoomRow,
  roomLabel,
} from './sidebar-room-grouping';
import { agentRoomGroupKey, roomViewGroupKey } from './sidebar-store';
import { SidebarSubagentList } from './sidebar-subagent-list';

/** dnd container ids. Each identifies a reorderable sibling set. */
const AGENTS_CONTAINER = 'agents';
const ROOMS_CONTAINER = 'rooms';
/** Sessions of one agent's room group (agent-focused view). */
const agentSessionsContainer = (locationId: string, roomKey: string): string =>
  `as:${locationId}|${roomKey}`;
/** Sessions of one agent within a room (room-focused view). */
const roomSessionsContainer = (roomKey: string, locationId: string): string =>
  `rs:${roomKey}|${locationId}`;

export const SidebarGroupedList = observer(function SidebarGroupedList() {
  // Live session→room connections + room names live on the server; pull them
  // once on mount and refresh names on focus so headers show names not ids.
  useEffect(() => {
    roomConnectionsStore.ensureLoaded();
    void agentsStore.load();
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

const AgentFocusedTree = observer(function AgentFocusedTree() {
  const locations = sidebarStore.filteredLocations;
  // Populated during render (each rendered group registers its ordered ids) so
  // the drag handler can resolve a container's siblings on drop.
  const containers: Record<string, string[]> = {
    [AGENTS_CONTAINER]: locations.map((location) => location.id),
  };
  const dnd = useSidebarDnd(containers, (containerId, orderedIds) => {
    if (containerId === AGENTS_CONTAINER) sidebarStore.setLocationOrder(orderedIds);
    else sidebarStore.setGroupOrder(containerId, orderedIds);
  });

  function renderSessionGroup(locationId: string, roomKey: string, roomSessions: SessionStore[]) {
    const container = agentSessionsContainer(locationId, roomKey);
    const ordered = sidebarStore.orderGroupItems(
      container,
      roomSessions,
      (session) => session.data.id,
      true
    );
    containers[container] = ordered.map((session) => session.data.id);
    const depth = 2;
    return (
      <SortableContext
        items={ordered.map((session) => makeDndId(container, session.data.id))}
        strategy={verticalListSortingStrategy}
      >
        {ordered.map((session) => (
          <SortableLeaf key={session.data.id} id={makeDndId(container, session.data.id)}>
            <SidebarSessionItem locationId={locationId} sessionId={session.data.id} depth={depth} />
          </SortableLeaf>
        ))}
      </SortableContext>
    );
  }

  return (
    <DndContext {...dnd}>
      <SortableContext
        items={locations.map((location) => makeDndId(AGENTS_CONTAINER, location.id))}
        strategy={verticalListSortingStrategy}
      >
        {locations.map((location) => {
          const locationId = location.id;
          const expanded = sidebarStore.expandedLocationIds.has(locationId);
          const allSessions = expanded ? sidebarStore.visibleSessionsForLocation(locationId) : [];
          // Subagent sessions nest under their subagent row; the rest group by room.
          const subagentSessions = allSessions.filter(isSubagentSession);
          const grouped = groupByRoom(allSessions.filter((s) => !isSubagentSession(s)));
          return (
            <SortableBranch
              key={locationId}
              id={makeDndId(AGENTS_CONTAINER, locationId)}
              header={<SidebarLocationItem locationId={locationId} depth={0} />}
            >
              {/* The agent's own rooms/sessions come first, then its subagents. */}
              {expanded &&
                grouped.map(([roomKey, roomSessions]) => {
                  const groupKey = agentRoomGroupKey(locationId, roomKey);
                  const roomExpanded = sidebarStore.isGroupExpanded(groupKey);
                  return (
                    <div key={roomKey}>
                      <RoomRow
                        label={roomLabel(roomKey)}
                        count={roomSessions.length}
                        expanded={roomExpanded}
                        depth={1}
                        bridgeType={switchRoomsStore.roomBridgeTypeById(roomKey)}
                        onToggle={() => sidebarStore.toggleGroupExpanded(groupKey)}
                        onOpenGateway={() => openRoomInGateway(roomKey)}
                        onOpenChannel={
                          switchRoomsStore.roomChannelUrl(roomKey)
                            ? () => openRoomInMessagingApp(roomKey)
                            : null
                        }
                      />
                      {roomExpanded && renderSessionGroup(locationId, roomKey, roomSessions)}
                    </div>
                  );
                })}
              {expanded && (
                <SidebarSubagentList
                  locationId={locationId}
                  sessions={subagentSessions}
                  depth={1}
                />
              )}
            </SortableBranch>
          );
        })}
      </SortableContext>
    </DndContext>
  );
});

const RoomFocusedTree = observer(function RoomFocusedTree() {
  // Collect every visible session across mounted agents, tagged with its agent.
  const tagged: { locationId: string; session: SessionStore }[] = [];
  for (const location of sidebarStore.filteredLocations) {
    for (const session of sidebarStore.visibleSessionsForLocation(location.id)) {
      tagged.push({ locationId: location.id, session });
    }
  }

  const grouped = groupByRoom(tagged.map((t) => t.session));
  const byKey = new Map(grouped);
  const orderedRoomKeys = sidebarStore.orderRoomKeys(grouped.map(([roomKey]) => roomKey));

  const containers: Record<string, string[]> = { [ROOMS_CONTAINER]: orderedRoomKeys };
  const dnd = useSidebarDnd(containers, (containerId, orderedIds) => {
    if (containerId === ROOMS_CONTAINER) sidebarStore.setRoomOrder(orderedIds);
    else sidebarStore.setGroupOrder(containerId, orderedIds);
  });

  return (
    <DndContext {...dnd}>
      <SortableContext
        items={orderedRoomKeys.map((roomKey) => makeDndId(ROOMS_CONTAINER, roomKey))}
        strategy={verticalListSortingStrategy}
      >
        {orderedRoomKeys.map((roomKey) => {
          const roomSessions = byKey.get(roomKey) ?? [];
          // Rooms in this view always have sessions, so default to expanded.
          const roomViewKey = roomViewGroupKey(roomKey);
          const expanded = sidebarStore.isGroupExpanded(roomViewKey);
          const sessionIds = new Set(roomSessions.map((s) => s.data.id));
          const byLocation = sidebarStore.filteredLocations
            .map((location) => ({
              locationId: location.id,
              sessions: tagged
                .filter((t) => t.locationId === location.id && sessionIds.has(t.session.data.id))
                .map((t) => t.session),
            }))
            .filter((entry) => entry.sessions.length > 0);

          return (
            <SortableBranch
              key={roomKey}
              id={makeDndId(ROOMS_CONTAINER, roomKey)}
              header={
                <RoomRow
                  label={roomLabel(roomKey)}
                  count={roomSessions.length}
                  expanded={expanded}
                  depth={0}
                  bridgeType={switchRoomsStore.roomBridgeTypeById(roomKey)}
                  onToggle={() => sidebarStore.toggleGroupExpanded(roomViewKey)}
                  onOpenGateway={() => openRoomInGateway(roomKey)}
                  onOpenChannel={
                    switchRoomsStore.roomChannelUrl(roomKey)
                      ? () => openRoomInMessagingApp(roomKey)
                      : null
                  }
                />
              }
            >
              {expanded &&
                byLocation.map((entry) => {
                  // Reuse the agent row so it matches the agent-focused view
                  // (icon, hover-chevron, sizing). Its expand state is the global
                  // location expand, shared across the rooms an agent appears in.
                  const agentExpanded = sidebarStore.expandedLocationIds.has(entry.locationId);
                  // The agent's own sessions in this room render under it; the
                  // subagents that have a session here render as sibling rows at
                  // the same depth as the agent (not nested inside it).
                  const parentSessions = entry.sessions.filter((s) => !isSubagentSession(s));
                  const subagentSessions = entry.sessions.filter(isSubagentSession);
                  const container = roomSessionsContainer(roomKey, entry.locationId);
                  const orderedParent = sidebarStore.orderGroupItems(
                    container,
                    parentSessions,
                    (session) => session.data.id,
                    true
                  );
                  containers[container] = orderedParent.map((session) => session.data.id);
                  return (
                    <Fragment key={entry.locationId}>
                      <SidebarLocationItem locationId={entry.locationId} depth={1} />
                      {agentExpanded && (
                        <SortableContext
                          items={orderedParent.map((session) =>
                            makeDndId(container, session.data.id)
                          )}
                          strategy={verticalListSortingStrategy}
                        >
                          {orderedParent.map((session) => (
                            <SortableLeaf
                              key={session.data.id}
                              id={makeDndId(container, session.data.id)}
                            >
                              <SidebarSessionItem
                                locationId={entry.locationId}
                                sessionId={session.data.id}
                                depth={2}
                              />
                            </SortableLeaf>
                          ))}
                        </SortableContext>
                      )}
                      {subagentSessions.length > 0 && (
                        <SidebarSubagentList
                          locationId={entry.locationId}
                          depth={1}
                          sessions={subagentSessions}
                          onlyWithSessions
                          groupSessionsByRoom={false}
                        />
                      )}
                    </Fragment>
                  );
                })}
            </SortableBranch>
          );
        })}
      </SortableContext>
    </DndContext>
  );
});
