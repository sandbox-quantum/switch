import { observer } from 'mobx-react-lite';
import { Fragment } from 'react';
import type { SessionStore } from '@renderer/features/sessions/stores/session-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { RoomAgentRow } from './room-agent-row';
import { filterRoomGroups, sortRoomGroups } from './room-tree-data';
import { SidebarSessionItem } from './session-item';
import { makeDndId, ROOMS_CONTAINER, SortableBranch, SortableList } from './sidebar-dnd';
import {
  groupByRoom,
  isRoomNameKnown,
  isRoomViewActive,
  deleteRoomAction,
  openRoomInMessagingApp,
  openRoomView,
  RoomRow,
  roomLabel,
  sessionRoomId,
} from './sidebar-room-grouping';
import { roomAgentGroupKey, roomViewGroupKey, UNASSIGNED_ROOM_KEY } from './sidebar-store';
import {
  type AgentEntry,
  agentSessions,
  agentsInActiveScope,
  scopedAgents,
} from './sidebar-tree-data';

/**
 * The room-grouped sidebar: rooms at the top level, their member agents
 * beneath, and each agent's sessions in that room below that.
 *
 * A room here is a place, not a property of a session — it is listed because it
 * exists and concerns you, and its rows act on the room itself (add a member,
 * remove one, open the channel). That is why this is a separate tree from the
 * agent-grouped one rather than the same tree with the nesting inverted, down
 * to its own agent row.
 */

/** Which of this app's agents belong to which room. Membership, not sessions:
 * an agent is in a room whether or not it is running there — and, just as
 * importantly, is *out* of it the moment membership is dropped, without waiting
 * for a session that is still pointed at the room to end.
 *
 * The membership itself is owned by the room store, which is also what the
 * member count and the invite picker read; this only puts a local agent behind
 * each id. Agent filters are deliberately not applied — they narrow the agent
 * view, and a room's membership is a fact about the room, not about which
 * agents you are currently looking at. */
function membersByRoom(): Map<string, AgentEntry[]> {
  const byId = new Map<string, AgentEntry>();
  for (const entry of agentsInActiveScope()) {
    if (entry.agent.switchAgentId) byId.set(entry.agent.switchAgentId, entry);
  }
  const byRoom = new Map<string, AgentEntry[]>();
  for (const [roomId, memberIds] of switchRoomsStore.localMemberIdsByRoom) {
    const entries = memberIds
      .map((switchAgentId) => byId.get(switchAgentId))
      .filter((entry): entry is AgentEntry => entry !== undefined);
    if (entries.length > 0) byRoom.set(roomId, entries);
  }
  return byRoom;
}

/**
 * Every room this tree puts a top-level row under, before filters narrow it: one
 * of this app's agents is a member of it, a visible session is connected to it,
 * or it is listed on its own account — every room on a server this install
 * manages, and rooms you created elsewhere. None of that waits on a session, so
 * a room you just made is there immediately.
 *
 * Shared with Collapse all, which needs the same set of rows without the tree
 * being on screen to ask.
 */
export function listedRoomKeys(): string[] {
  const keys = new Set<string>([
    ...switchRoomsStore.listedRoomsInActiveScope.map((room) => room.id),
    ...membersByRoom().keys(),
  ]);
  for (const entry of scopedAgents()) {
    for (const session of agentSessions(entry)) {
      const roomKey = sessionRoomId(session);
      if (roomKey) keys.add(roomKey);
    }
  }
  return [...keys];
}

export const RoomTree = observer(function RoomTree() {
  const showAddAgentsToRoomModal = useShowModal('addAgentsToRoomModal');
  const showDeleteRoomModal = useShowModal('deleteRoomModal');

  // Tag every visible session with the agent it belongs to, then group by room.
  const bySession = new Map<string, AgentEntry>();
  const allSessions: SessionStore[] = [];
  for (const entry of scopedAgents()) {
    for (const session of agentSessions(entry)) {
      bySession.set(session.data.id, entry);
      allSessions.push(session);
    }
  }

  const members = membersByRoom();
  const alwaysShow = listedRoomKeys();

  const sorted = sortRoomGroups(
    filterRoomGroups(
      groupByRoom(allSessions, alwaysShow)
        // This view lists rooms. A session connected to none of them is not in
        // a room, and a bucket standing in for that is not one either — the
        // agent view is where a session with no room belongs.
        .filter(([roomKey]) => roomKey !== UNASSIGNED_ROOM_KEY)
        .map(([roomKey, sessions]) => ({
          roomKey,
          label: roomLabel(roomKey),
          bridgeType: switchRoomsStore.roomBridgeTypeById(roomKey),
          createdAt: switchRoomsStore.roomSummaryById(roomKey)?.createdAt ?? null,
          sessions,
        })),
      {
        bridgeTypes: sidebarStore.filterBridgeTypes,
        hasLiveSession: sidebarStore.filterRoomHasLiveSession,
      }
    ),
    sidebarStore.roomSortBy
  );
  // The user's dragged order sits on top of the default one, so a room they
  // placed stays put while rooms they have not touched keep sorting normally.
  const groups = sidebarStore.orderRooms(sorted, (group) => group.roomKey);

  if (groups.length === 0 && sidebarStore.hasActiveRoomFilters) {
    return <p className="px-2 py-3 text-xs text-foreground-muted">No rooms match filters</p>;
  }

  return (
    <SortableList
      containerId={ROOMS_CONTAINER}
      itemIds={groups.map((group) => group.roomKey)}
      onReorder={(orderedIds) => sidebarStore.setRoomOrder(orderedIds)}
    >
      {groups.map(({ roomKey, sessions: roomSessions }) => {
        const roomViewKey = roomViewGroupKey(roomKey);
        const expanded = sidebarStore.isGroupExpanded(roomViewKey);
        const agentsInRoom = members.get(roomKey) ?? [];
        return (
          <SortableBranch
            key={roomKey}
            id={makeDndId(ROOMS_CONTAINER, roomKey)}
            header={
              <RoomRow
                label={roomLabel(roomKey)}
                nameKnown={isRoomNameKnown(roomKey)}
                nameBlockedBySignIn={switchRoomsStore.roomNameBlockedBySignIn(roomKey)}
                hasChildren={agentsInRoom.length > 0}
                expanded={expanded}
                depth={0}
                bridgeType={switchRoomsStore.roomBridgeTypeById(roomKey)}
                onToggle={() => sidebarStore.toggleGroupExpanded(roomViewKey)}
                onSelect={() => openRoomView(roomKey)}
                isActive={isRoomViewActive(roomKey)}
                onOpenChannel={
                  switchRoomsStore.roomChannelUrl(roomKey)
                    ? () => openRoomInMessagingApp(roomKey)
                    : null
                }
                onAddAgent={() => showAddAgentsToRoomModal({ roomId: roomKey })}
                onDelete={deleteRoomAction(roomKey, showDeleteRoomModal)}
              />
            }
          >
            {expanded &&
              agentsInRoom.map((entry) => {
                const sessionsHere = roomSessions.filter(
                  (session) => bySession.get(session.data.id)?.agent.id === entry.agent.id
                );
                const agentExpanded = sidebarStore.isGroupExpanded(
                  roomAgentGroupKey(roomKey, entry.agent.id)
                );
                return (
                  <Fragment key={entry.agent.id}>
                    <RoomAgentRow
                      agent={entry.agent}
                      roomId={roomKey}
                      hasSessions={sessionsHere.length > 0}
                      depth={1}
                    />
                    {agentExpanded &&
                      sessionsHere.map((session) => (
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
          </SortableBranch>
        );
      })}
    </SortableList>
  );
});
