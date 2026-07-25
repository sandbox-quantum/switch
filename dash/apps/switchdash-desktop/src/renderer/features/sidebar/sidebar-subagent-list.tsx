import { Bot, ChevronRight, Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import type { SessionStore } from '@renderer/features/sessions/stores/session-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import {
  useNavigate,
  useParams,
  useWorkspaceSlots,
} from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { useAgent } from '@renderer/lib/stores/use-agents';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import { representativeAgent } from '@shared/core/agents/agents';
import { SidebarSessionItem } from './session-item';
import { SidebarItemMiniButton, SidebarMenuRow } from './sidebar-primitives';
import {
  groupByRoom,
  openRoomInGateway,
  openRoomInMessagingApp,
  RoomRow,
  roomLabel,
} from './sidebar-room-grouping';
import { depthIndent, UNASSIGNED_ROOM_KEY } from './sidebar-store';

/** The subagent a session was launched as, if any. */
function subagentNameOf(session: SessionStore): string | undefined {
  return 'subagentName' in session.data ? session.data.subagentName : undefined;
}

/** Expand-state key for a subagent row (its sessions live underneath). */
function subagentKey(locationId: string, name: string): string {
  return `sa:${locationId}|${name}`;
}

/** Expand-state key for a room nested under a subagent. */
function subagentRoomKey(locationId: string, name: string, roomKey: string): string {
  return `sar:${locationId}|${name}|${roomKey}`;
}

/**
 * The Claude Code subagents of a location's agent, rendered as first-class agent
 * rows (same size/icon/affordances as the parent) nested under it. Each row
 * starts a session that runs as that subagent and, when expanded, lists the
 * sessions launched as it — grouped by room exactly like the parent agent. A
 * subagent discovered locally but not registered on the gateway is flagged
 * "local" so the drift is visible.
 *
 * `sessions` is the location's subagent-launched sessions; pass them in the
 * agent-focused view so they nest here. Omit them (room-focused view) to render
 * only the launcher rows.
 */
export const SidebarSubagentList = observer(function SidebarSubagentList({
  locationId,
  sessions = [],
  depth = 1,
  onlyWithSessions = false,
  groupSessionsByRoom = true,
}: {
  locationId: string;
  sessions?: SessionStore[];
  /** Tree depth of the subagent rows; their rooms/sessions nest below it. */
  depth?: number;
  /** Only render subagents that have a session in `sessions` (room-focused
   * view), instead of every discovered subagent. */
  onlyWithSessions?: boolean;
  /** Group each subagent's sessions by room (agent-focused view). When false,
   * list them flat — used in the room-focused view, where the room is already
   * the grouping. */
  groupSessionsByRoom?: boolean;
}) {
  const showCreateSessionModal = useShowModal('sessionModal');
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { params: locationParams } = useParams('location');
  const activeSubagent =
    currentView === 'location' && locationParams.locationId === locationId
      ? locationParams.subagentName
      : undefined;

  const locationAgents = agentsStore.byLocation.get(locationId) ?? [];
  const agent = representativeAgent(locationAgents) ?? null;

  // Only agent types with a subagents capability discover/launch subagents.
  const { data: providerMeta } = useAgent(agent?.providerId ?? '');
  const supportsSubagents = !!agent && providerMeta?.capabilities.subagents.kind !== 'none';

  // Subagents are ordinary agent rows that carry a definitionName and share this
  // location with the parent (CHOO-1440) — sourced from the agent table, not a
  // separate discovery/reconcile call.
  const discovered = locationAgents
    .filter((a) => a.definitionName != null)
    .map((a) => ({ name: a.definitionName as string, description: null, registered: true }));

  // Group the location's subagent sessions by the subagent they ran as.
  const sessionsByName = new Map<string, SessionStore[]>();
  for (const session of sessions) {
    const name = subagentNameOf(session);
    if (!name) continue;
    const list = sessionsByName.get(name);
    if (list) list.push(session);
    else sessionsByName.set(name, [session]);
  }

  const discoveredByName = new Map(discovered.map((s) => [s.name, s]));
  const names = onlyWithSessions
    ? // Room-focused view: only subagents with a session in this room.
      [...sessionsByName.keys()]
    : // Agent-focused view: every discovered subagent, plus any that still have
      // sessions but are no longer discovered (creds/definition removed) so
      // their runs are never orphaned.
      [
        ...discovered.map((s) => s.name),
        ...[...sessionsByName.keys()].filter((name) => !discoveredByName.has(name)),
      ];

  if (!supportsSubagents || names.length === 0) return null;

  return (
    <>
      {names.map((name) => {
        const subagent = discoveredByName.get(name) ?? null;
        const subSessions = sessionsByName.get(name) ?? [];
        const expanded = sidebarStore.isGroupExpanded(subagentKey(locationId, name));
        const toggle = () => sidebarStore.toggleGroupExpanded(subagentKey(locationId, name));
        const isActive = activeSubagent === name;
        const open = () => navigate('location', { locationId, subagentName: name });
        return (
          <div key={name}>
            <SidebarMenuRow
              className="group/row flex h-8 justify-between px-1"
              style={depthIndent(depth)}
              data-active={isActive || undefined}
              isActive={isActive}
              onMouseDown={(e) => e.preventDefault()}
              onClick={open}
            >
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <SidebarItemMiniButton
                  type="button"
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
                  className="relative"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle();
                  }}
                >
                  {/* A subagent's type is always its parent's, so it shows the
                      parent agent's icon (falling back until the parent loads). */}
                  {agent ? (
                    <AgentIcon
                      id={agent.providerId}
                      size={16}
                      className="absolute h-4 w-4 opacity-100 transition-opacity duration-150 group-hover/row:opacity-0"
                    />
                  ) : (
                    <Bot className="absolute h-4 w-4 opacity-100 transition-opacity duration-150 group-hover/row:opacity-0" />
                  )}
                  <ChevronRight
                    className={cn(
                      'absolute h-4 w-4 opacity-0 transition-all duration-150 group-hover/row:opacity-100',
                      expanded && 'rotate-90'
                    )}
                  />
                </SidebarItemMiniButton>
                <span
                  className="min-w-0 flex-1 truncate text-sm"
                  title={subagent?.description ?? undefined}
                >
                  {name}
                </span>
                {subagent?.registered === false && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] text-amber-600 dark:text-amber-400">
                          local
                        </span>
                      }
                    />
                    <TooltipContent>
                      Discovered locally but not registered on the Switch server.
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              <Tooltip>
                <TooltipTrigger
                  className="h-6"
                  render={
                    <SidebarItemMiniButton
                      type="button"
                      aria-label={`New session as ${name}`}
                      className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        showCreateSessionModal({ locationId, subagentName: name });
                      }}
                    >
                      <Plus className="h-4 w-4" />
                    </SidebarItemMiniButton>
                  }
                />
                <TooltipContent>New session as {name}</TooltipContent>
              </Tooltip>
            </SidebarMenuRow>
            {expanded &&
              !groupSessionsByRoom &&
              subSessions.map((session) => (
                <SidebarSessionItem
                  key={session.data.id}
                  locationId={locationId}
                  sessionId={session.data.id}
                  depth={depth + 1}
                />
              ))}
            {expanded &&
              groupSessionsByRoom &&
              groupByRoom(subSessions).map(([roomKey, roomSessions]) => {
                // Sessions with no room sit at the same depth as the subagent's
                // room rows — direct children of the subagent, just without a
                // room header above them.
                if (roomKey === UNASSIGNED_ROOM_KEY) {
                  return roomSessions.map((session) => (
                    <SidebarSessionItem
                      key={session.data.id}
                      locationId={locationId}
                      sessionId={session.data.id}
                      depth={depth + 1}
                    />
                  ));
                }
                const groupKey = subagentRoomKey(locationId, name, roomKey);
                const roomExpanded = sidebarStore.isGroupExpanded(groupKey);
                return (
                  <div key={roomKey}>
                    <RoomRow
                      label={roomLabel(roomKey)}
                      count={roomSessions.length}
                      expanded={roomExpanded}
                      depth={depth + 1}
                      bridgeType={switchRoomsStore.roomBridgeTypeById(roomKey)}
                      onToggle={() => sidebarStore.toggleGroupExpanded(groupKey)}
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
                          depth={depth + 2}
                        />
                      ))}
                  </div>
                );
              })}
          </div>
        );
      })}
    </>
  );
});
