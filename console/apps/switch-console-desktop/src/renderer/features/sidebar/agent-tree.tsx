import { observer } from 'mobx-react-lite';
import type { SessionStore } from '@renderer/features/sessions/stores/session-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { SidebarAgentItem } from './agent-item';
import { SidebarSessionItem } from './session-item';
import { AGENTS_CONTAINER, makeDndId, SortableBranch, SortableList } from './sidebar-dnd';
import {
  groupByRoom,
  isRoomNameKnown,
  isRoomViewActive,
  openRoomInMessagingApp,
  openRoomView,
  RoomRow,
  roomLabel,
} from './sidebar-room-grouping';
import { agentExpandKey, agentRoomGroupKey, UNASSIGNED_ROOM_KEY } from './sidebar-store';
import { agentSessions, scopedAgents } from './sidebar-tree-data';

/**
 * The agent-grouped sidebar: agents at the top level, their sessions beneath,
 * bucketed by whichever room each session is connected to.
 *
 * Here a room is a property of a session — a heading over some of an agent's
 * work — so rooms with nothing running in them do not appear, and the row
 * offers only navigation. The room-grouped tree treats rooms as the subject
 * instead; the two are separate on purpose.
 */

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
              nameKnown={isRoomNameKnown(roomKey)}
              nameBlockedBySignIn={switchRoomsStore.roomNameBlockedBySignIn(roomKey)}
              hasChildren={roomSessions.length > 0}
              expanded={roomExpanded}
              depth={depth}
              bridgeType={switchRoomsStore.roomBridgeTypeById(roomKey)}
              onToggle={() => sidebarStore.toggleGroupExpanded(groupKey)}
              onSelect={() => openRoomView(roomKey)}
              isActive={isRoomViewActive(roomKey)}
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

export const AgentTree = observer(function AgentTree() {
  const entries = scopedAgents();
  return (
    <SortableList
      containerId={AGENTS_CONTAINER}
      itemIds={entries.map((entry) => entry.agent.id)}
      onReorder={(orderedIds) => sidebarStore.setAgentOrder(orderedIds)}
    >
      {entries.map((entry) => {
        const expanded = sidebarStore.isGroupExpanded(agentExpandKey(entry.agent.id));
        const sessions = agentSessions(entry);
        return (
          <SortableBranch
            key={entry.agent.id}
            id={makeDndId(AGENTS_CONTAINER, entry.agent.id)}
            header={
              <SidebarAgentItem agent={entry.agent} hasSessions={sessions.length > 0} depth={0} />
            }
          >
            {expanded && (
              <AgentSessions
                agentId={entry.agent.id}
                locationId={entry.agent.locationId}
                sessions={sessions}
                depth={1}
              />
            )}
          </SortableBranch>
        );
      })}
    </SortableList>
  );
});
