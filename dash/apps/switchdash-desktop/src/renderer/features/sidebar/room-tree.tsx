import { observer } from 'mobx-react-lite';
import { Fragment } from 'react';
import type { SessionStore } from '@renderer/features/sessions/stores/session-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { RoomAgentRow } from './room-agent-row';
import { filterRoomGroups, sortRoomGroups } from './room-tree-data';
import { SidebarSessionItem } from './session-item';
import {
  groupByRoom,
  isRoomViewActive,
  openRoomInGateway,
  openRoomInMessagingApp,
  openRoomView,
  RoomRow,
  roomLabel,
} from './sidebar-room-grouping';
import { roomAgentGroupKey, roomViewGroupKey, UNASSIGNED_ROOM_KEY } from './sidebar-store';
import { type AgentEntry, agentSessions, scopedAgents } from './sidebar-tree-data';

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
 * for a session that is still pointed at the room to end. */
function membersByRoom(): Map<string, AgentEntry[]> {
  const byRoom = new Map<string, AgentEntry[]>();
  for (const entry of scopedAgents()) {
    const { serverId, switchAgentId } = entry.agent;
    if (!serverId || !switchAgentId) continue;
    for (const membership of switchRoomsStore.roomsFor(serverId, switchAgentId) ?? []) {
      if (membership.archived) continue;
      const list = byRoom.get(membership.roomId);
      if (list) list.push(entry);
      else byRoom.set(membership.roomId, [entry]);
    }
  }
  return byRoom;
}

export const RoomTree = observer(function RoomTree() {
  const showAddAgentsToRoomModal = useShowModal('addAgentsToRoomModal');

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
  // A room is listed when one of this app's agents is a member of it, when it
  // has a session, or when it is listed on its own account — every room on a
  // server this install manages, and rooms you created elsewhere. None of that
  // waits on a session, so a room you just made is there immediately.
  const alwaysShow = [
    ...new Set([
      ...switchRoomsStore.listedRoomsInActiveScope.map((room) => room.id),
      ...members.keys(),
    ]),
  ];

  const groups = sortRoomGroups(
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

  if (groups.length === 0 && sidebarStore.hasActiveRoomFilters) {
    return <p className="px-2 py-3 text-xs text-foreground-muted">No rooms match filters</p>;
  }

  return (
    <>
      {groups.map(({ roomKey, sessions: roomSessions }) => {
        const roomViewKey = roomViewGroupKey(roomKey);
        const expanded = sidebarStore.isGroupExpanded(roomViewKey);
        const agentsInRoom = members.get(roomKey) ?? [];
        return (
          <div key={roomKey}>
            <RoomRow
              label={roomLabel(roomKey)}
              count={roomSessions.length}
              expanded={expanded}
              depth={0}
              bridgeType={switchRoomsStore.roomBridgeTypeById(roomKey)}
              onToggle={() => sidebarStore.toggleGroupExpanded(roomViewKey)}
              onSelect={() => openRoomView(roomKey)}
              isActive={isRoomViewActive(roomKey)}
              onOpenGateway={() => openRoomInGateway(roomKey)}
              onOpenChannel={
                switchRoomsStore.roomChannelUrl(roomKey)
                  ? () => openRoomInMessagingApp(roomKey)
                  : null
              }
              onAddAgent={() => showAddAgentsToRoomModal({ roomId: roomKey })}
            />
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
                    <RoomAgentRow agent={entry.agent} roomId={roomKey} depth={1} />
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
          </div>
        );
      })}
    </>
  );
});
