import { ChevronDown, DoorOpen, MessageSquare, Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { openRoom } from '@renderer/features/switch-rooms/open-room';
import { roomTitle } from '@renderer/features/switch-rooms/room-labels';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useRemoteAgents } from '@renderer/lib/stores/use-remote-agents';
import { Button } from '@renderer/lib/ui/button';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';
import { ServerPage, ServerTableEmpty } from './server-page';
import { ServerSectionTitlebar } from './server-section-titlebar';
import { switchRoomsStore } from './switch-rooms-store';
import { switchServersStore } from './switch-servers-store';

/** Group key for a room with no messaging app behind it. */
const UNBRIDGED = '';

function useServerId(): string {
  return useParams('serverRooms').params.serverId;
}

const ServerRoomsTitlebar = observer(function ServerRoomsTitlebar() {
  return <ServerSectionTitlebar serverId={useServerId()} icon={DoorOpen} label="Your Rooms" />;
});

const ServerRoomsPanel = observer(function ServerRoomsPanel() {
  const serverId = useServerId();
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  const showCreateRoomModal = useShowModal('createRoomModal');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    void refreshSidebarRoomState(false);
  }, [serverId]);

  const rooms = switchRoomsStore.listedRoomsOnServer(serverId);
  const signedOut = switchRoomsStore.serversNotSignedIn.some((s) => s.id === serverId);
  const failed = switchRoomsStore.serversThatFailedToLoad.some((s) => s.id === serverId);

  const query = filter.trim().toLowerCase();
  const matching = query === '' ? rooms : rooms.filter((r) => r.name.toLowerCase().includes(query));
  const groups = groupByMessagingApp(matching);

  return (
    <ServerPage
      title="Your Rooms"
      description={`Rooms on ${server?.name ?? 'this server'}. Create one, see who is in it, and where it is bridged.`}
      action={
        <Button size="sm" disabled={signedOut} onClick={() => showCreateRoomModal({ serverId })}>
          <Plus className="size-4" />
          Create room
        </Button>
      }
    >
      {/* Three ways to have no rows, and only one of them means "there are no
        rooms". Saying that in the other two would send someone off to create a
        room they already have. */}
      {signedOut ? (
        <ServerTableEmpty>
          Sign in to {server?.name ?? 'this server'} to see its rooms.
        </ServerTableEmpty>
      ) : failed ? (
        <ServerTableEmpty>
          This server&apos;s room list could not be read. Refresh from Home to try again.
        </ServerTableEmpty>
      ) : rooms.length === 0 ? (
        <ServerTableEmpty>
          No rooms here yet. Create one to give your agents somewhere to work.
        </ServerTableEmpty>
      ) : (
        <div className="flex flex-col gap-6">
          <SearchInput
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter rooms by name…"
            aria-label="Filter rooms by name"
          />
          {/* The filter finding nothing is not the same as the server having no
            rooms, and the empty state above answers a question this user is not
            asking. */}
          {groups.length === 0 ? (
            <p className="py-2 text-sm text-foreground-muted">
              No room here matches “{filter.trim()}”.
            </p>
          ) : (
            groups.map((group) => (
              <MessagingAppGroup
                key={group.key}
                group={group}
                serverId={serverId}
                // Nothing folds while a filter is on. Typing a name and being
                // shown a "Show 3 more" where the match is hiding is the one
                // moment the fold would cost more than it saves.
                fold={query === ''}
              />
            ))
          )}
        </div>
      )}
    </ServerPage>
  );
});

type RoomGroup = {
  key: string;
  label: string;
  bridgeType: string | null;
  rooms: RemoteRoomSummary[];
};

/**
 * Rooms under the messaging app they are reachable in.
 *
 * Which app a room is in is the thing people scan this page for — it decides
 * where a conversation actually happens — so it is the heading rather than a
 * column. Grouped by the bridge's own display name, because a server can have
 * two of the same platform (two Slack workspaces) and calling both "Slack"
 * would merge two different places into one list. Rooms in no app sort last:
 * they are the exception, and leading with them buries the rest.
 */
function groupByMessagingApp(rooms: RemoteRoomSummary[]): RoomGroup[] {
  const groups = new Map<string, RoomGroup>();
  for (const room of rooms) {
    const key = room.bridgeType ? (room.bridgeDisplayName ?? room.bridgeType) : UNBRIDGED;
    const existing = groups.get(key);
    if (existing) {
      existing.rooms.push(room);
      continue;
    }
    groups.set(key, {
      key,
      label: room.bridgeType
        ? (room.bridgeDisplayName ?? bridgePlatformLabel(room.bridgeType))
        : 'No messaging app',
      bridgeType: room.bridgeType ?? null,
      rooms: [room],
    });
  }
  for (const group of groups.values()) {
    group.rooms.sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === UNBRIDGED) return 1;
    if (b.key === UNBRIDGED) return -1;
    return a.label.localeCompare(b.label);
  });
}

/**
 * How many rooms a messaging app shows before the rest are folded away.
 *
 * A single busy workspace can hold more rooms than the whole page otherwise
 * has, and left whole it pushes every other app off the screen — so the page
 * stops answering "where are my rooms" and answers only "what is in Slack".
 * Five is enough to see the group is real and to recognise the room you came
 * for; the count in the heading always says how many there are in total, so
 * nothing is hidden silently.
 */
const ROOMS_BEFORE_FOLD = 5;

const MessagingAppGroup = observer(function MessagingAppGroup({
  group,
  serverId,
  fold,
}: {
  group: RoomGroup;
  serverId: string;
  /** Whether long groups are cut short. False while the list is filtered. */
  fold: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [visible, setVisible] = useState(ROOMS_BEFORE_FOLD);

  const shown = fold ? group.rooms.slice(0, visible) : group.rooms;
  const remaining = group.rooms.length - shown.length;
  // One page at a time rather than the whole tail at once: a workspace with
  // forty rooms in it would otherwise unfold into the same wall the fold
  // exists to prevent, and there would be no way back to a readable page
  // short of collapsing the app entirely.
  const nextBatch = Math.min(remaining, ROOMS_BEFORE_FOLD);

  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="-mx-2 flex w-fit cursor-pointer items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-[var(--sel-soft)]"
      >
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-foreground-muted transition-transform',
            !open && '-rotate-90'
          )}
        />
        {hasBridgeIcon(group.bridgeType) ? (
          <BridgeIcon bridgeType={group.bridgeType} size={16} />
        ) : (
          <MessageSquare className="size-4 text-foreground-muted" />
        )}
        <span className="truncate text-sm font-medium text-foreground">{group.label}</span>
        <span className="shrink-0 text-xs text-foreground-muted">
          {group.rooms.length} {group.rooms.length === 1 ? 'room' : 'rooms'}
        </span>
      </button>

      {open && (
        <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
          {shown.map((room) => (
            <RoomRow key={room.id} room={room} serverId={serverId} />
          ))}
          {fold && group.rooms.length > ROOMS_BEFORE_FOLD && (
            <button
              type="button"
              onClick={() =>
                setVisible((v) => (remaining > 0 ? v + ROOMS_BEFORE_FOLD : ROOMS_BEFORE_FOLD))
              }
              className="flex w-full cursor-pointer items-center gap-1.5 px-4 py-2.5 text-sm text-foreground-muted transition-colors hover:bg-[var(--fill)] hover:text-foreground"
            >
              <ChevronDown className={cn('size-4 shrink-0', remaining === 0 && 'rotate-180')} />
              {remaining > 0 ? `Show ${nextBatch} more` : 'Show fewer'}
            </button>
          )}
        </div>
      )}
    </section>
  );
});

const RoomRow = observer(function RoomRow({
  room,
  serverId,
}: {
  room: RemoteRoomSummary;
  serverId: string;
}) {
  const members = switchRoomsStore.localMemberIds(room.id);
  const { data: remoteAgents } = useRemoteAgents(serverId);
  const remoteById = new Map((remoteAgents ?? []).map((agent) => [agent.id, agent]));
  const localAgents = agentsStore
    .agentsOnServer(serverId)
    .filter((agent) => agent.switchAgentId != null && members.includes(agent.switchAgentId));

  return (
    <button
      type="button"
      onClick={() => void openRoom(room.id)}
      // A solid hover rather than a translucent one, because the discs holding
      // the agent marks have to be filled with whatever the row is filled with
      // — an overlay would leave them reading as holes punched in the row.
      className="group/room flex w-full cursor-pointer items-center gap-3 bg-background px-4 py-3 text-left transition-colors hover:bg-[var(--fill)]"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{roomTitle(room)}</span>
        {/* An empty room is a state, not a quantity. "0 agents" reads as a
          measurement of something that is working; a room nobody is in is a
          room that cannot answer, and it should say so in words. */}
        <span className="text-xs text-foreground-muted">
          {room.agentCount === 0
            ? 'No agent in this room yet'
            : `${room.agentCount} ${room.agentCount === 1 ? 'agent' : 'agents'}`}
        </span>
      </div>

      {/* The agents of this install that are in the room, by the mark of what
        they run. Deliberately not a second count: the number above is the
        server's, other people's agents included, and only these are ones this
        app could open. The tooltip says so rather than leaving two numbers on
        one row disagreeing in silence. */}
      {localAgents.length > 0 && (
        <Tooltip>
          <TooltipTrigger
            render={
              // Overlapped rather than spaced: this is one fact — who is in
              // the room — and a stack reads as that, where an evenly spaced
              // row reads as a set of separate controls to click.
              //
              // Each avatar keeps its ring, so what the one in front hides is a
              // clean circle rather than a bitten-into picture — the avatars
              // are all different, and letting them interlock made two agents
              // read as one broken image.
              <span className="flex shrink-0 items-center -space-x-1.5">
                {localAgents.map((agent) => (
                  <span
                    key={agent.id}
                    className="flex size-6 items-center justify-center rounded-full bg-background ring-1 ring-[var(--hair-soft)] transition-colors group-hover/room:bg-[var(--fill)]"
                  >
                    <AgentAvatar
                      name={agent.name}
                      iconUrl={remoteById.get(agent.switchAgentId ?? '')?.iconUrl ?? null}
                      size={22}
                    />
                  </span>
                ))}
              </span>
            }
          />
          <TooltipContent>
            Your agents here: {localAgents.map((agent) => agent.name).join(', ')}
          </TooltipContent>
        </Tooltip>
      )}
    </button>
  );
});

export const serverRoomsView = {
  WrapView: ({ children }: { children: React.ReactNode; serverId: string }) => <>{children}</>,
  TitlebarSlot: ServerRoomsTitlebar,
  MainPanel: ServerRoomsPanel,
  canActivate: (params: unknown): GuardResult => {
    const serverId =
      typeof params === 'object' && params !== null
        ? (params as { serverId?: unknown }).serverId
        : undefined;
    if (typeof serverId !== 'string') return { ok: false, redirect: 'home' };
    return { ok: true };
  },
} satisfies ViewDefinition<{ serverId: string }>;
