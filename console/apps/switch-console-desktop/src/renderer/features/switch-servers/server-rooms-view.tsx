import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, DoorOpen, MessagesSquare, Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { ArchivedFold } from '@renderer/features/chats/components/archived-fold';
import { UnreadBadge } from '@renderer/features/chats/components/unread-badge';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { openRoom } from '@renderer/features/switch-rooms/open-room';
import { roomTitle } from '@renderer/features/switch-rooms/room-labels';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';
import { allReadableRooms, isConsoleGroupChatSummary } from './room-filters';
import { groupByMessagingApp, type RoomGroup } from './rooms-by-messaging-app';
import { ServerPage, ServerTableEmpty } from './server-page';
import { ServerSectionTitlebar } from './server-section-titlebar';
import { switchRoomsStore } from './switch-rooms-store';
import { switchServersStore } from './switch-servers-store';
import { useListedRoomsInWorkspace, useReadableRoomsInWorkspace } from './use-listed-rooms';

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

  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  const yours = useListedRoomsInWorkspace(workspaceId);
  const all = allReadableRooms(yours, useReadableRoomsInWorkspace(workspaceId));
  // Only someone who can read more than their own (an admin, or public rooms) gets the choice.
  const [showAll, setShowAll] = useState(false);
  const canShowAll = all.length > yours.length;
  const rooms = showAll && canShowAll ? all : yours;
  const signedOut = switchRoomsStore.workspacesNotSignedIn.some((w) => w.id === workspaceId);
  const failed = switchRoomsStore.workspacesThatFailedToLoad.some((w) => w.id === workspaceId);

  const query = filter.trim().toLowerCase();
  const matching = query === '' ? rooms : rooms.filter((r) => r.name.toLowerCase().includes(query));
  const groups = groupByMessagingApp(matching);
  const archived =
    chatsStore.serverId === serverId
      ? [...chatsStore.archived.values()]
          .filter(isConsoleGroupChatSummary)
          .filter((chat) => query === '' || chat.name.toLowerCase().includes(query))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];
  // Archived rooms in a messaging app; archived group chats come from the chats list above.
  const queryClient = useQueryClient();
  const archivedRoomsQuery = useQuery({
    queryKey: ['archived-rooms', workspaceId],
    queryFn: async () => {
      const found = await rpc.workspaces.listArchivedRooms({ workspaceId: workspaceId as string });
      switchRoomsStore.noteRooms(workspaceId as string, found);
      return found.filter((room) => !room.isConsoleChat);
    },
    enabled: workspaceId !== null && !signedOut,
  });
  const archivedRooms = (archivedRoomsQuery.data ?? [])
    .filter((room) => query === '' || room.name.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));
  async function unarchiveRoom(room: RemoteRoomSummary) {
    if (workspaceId === null) return;
    try {
      await rpc.workspaces.setRoomArchived({ workspaceId, roomId: room.id, archived: false });
      await queryClient.invalidateQueries({ queryKey: ['archived-rooms', workspaceId] });
      await switchRoomsStore.refreshRoomState();
      void refreshSidebarRoomState(true);
    } catch (error) {
      toast({ title: failureText(error, 'Could not unarchive the room.'), variant: 'destructive' });
    }
  }

  return (
    <ServerPage
      width={880}
      title="Your Rooms"
      description={`Rooms on ${server?.name ?? 'this server'}. Create one, see who is in it, and where it is bridged.`}
      action={
        <Button
          size="sm"
          disabled={signedOut || workspaceId === null}
          onClick={() => showCreateRoomModal({ serverId })}
        >
          <Plus className="size-4" />
          Create room
        </Button>
      }
    >
      {/* Four ways to have no rows, and only one of them means "there are no
        rooms". Saying that in the others would send someone off to create a
        room they already have. */}
      {workspaceId === null ? (
        <ServerTableEmpty>
          This server has no workspace yet, so its rooms cannot be read.
        </ServerTableEmpty>
      ) : signedOut ? (
        <ServerTableEmpty>
          Sign in to {server?.name ?? 'this server'} to see its rooms.
        </ServerTableEmpty>
      ) : failed ? (
        <ServerTableEmpty>
          This server&apos;s room list could not be read. Refresh from Home to try again.
        </ServerTableEmpty>
      ) : all.length === 0 ? (
        <ServerTableEmpty>
          No rooms here yet. Create one to give your agents somewhere to work.
        </ServerTableEmpty>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-2">
            {canShowAll && (
              <ToggleGroup
                multiple={false}
                value={[showAll ? 'all' : 'yours']}
                onValueChange={([value]) => {
                  if (value) setShowAll(value === 'all');
                }}
              >
                <ToggleGroupItem value="yours">Your rooms</ToggleGroupItem>
                <ToggleGroupItem value="all">All rooms</ToggleGroupItem>
              </ToggleGroup>
            )}
            <SearchInput
              containerClassName="flex-1"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter rooms by name…"
              aria-label="Filter rooms by name"
            />
          </div>
          {/* The filter finding nothing is not the same as the server having no
            rooms, and the empty state above answers a question this user is not
            asking. */}
          {groups.length === 0 ? (
            <p className="py-2 text-sm text-foreground-muted">
              {query === ''
                ? 'You are in none of these rooms yet. Choose All rooms to see the rest.'
                : `No room here matches “${filter.trim()}”.`}
            </p>
          ) : (
            groups.map((group) => (
              <MessagingAppGroup
                key={group.key}
                group={group}
                serverId={serverId}
                workspaceId={workspaceId}
                // Nothing folds while a filter is on. Typing a name and being
                // shown a "Show 3 more" where the match is hiding is the one
                // moment the fold would cost more than it saves.
                fold={query === ''}
              />
            ))
          )}
          <ArchivedFold
            count={archived.length + archivedRooms.length}
            error={
              (chatsStore.serverId === serverId ? chatsStore.archivedError : null) ??
              (archivedRoomsQuery.isError
                ? failureText(archivedRoomsQuery.error, 'Could not list the archived rooms.')
                : null)
            }
          >
            <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
              {archivedRooms.map((room) => (
                <div key={room.id} className="flex items-center gap-3 bg-background px-4 py-3">
                  {hasBridgeIcon(room.bridgeType) ? (
                    <BridgeIcon bridgeType={room.bridgeType} size={16} className="shrink-0" />
                  ) : (
                    <DoorOpen className="size-4 shrink-0 text-foreground-muted" />
                  )}
                  <button
                    type="button"
                    onClick={() => void openRoom(room.id)}
                    className="min-w-0 flex-1 cursor-pointer truncate text-left text-sm font-medium text-foreground hover:underline"
                  >
                    {roomTitle(room)}
                  </button>
                  {workspaceId !== null &&
                    switchRoomsStore.roomPermissions(workspaceId, room).canWrite && (
                      <Button size="sm" variant="outline" onClick={() => void unarchiveRoom(room)}>
                        Unarchive
                      </Button>
                    )}
                </div>
              ))}
              {archived.map((chat) => (
                <div key={chat.roomId} className="flex items-center gap-3 bg-background px-4 py-3">
                  <button
                    type="button"
                    onClick={() => void openRoom(chat.roomId)}
                    className="min-w-0 flex-1 cursor-pointer truncate text-left text-sm font-medium text-foreground hover:underline"
                  >
                    {chat.name}
                  </button>
                  {chat.canManage && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void chatsStore.unarchive(serverId, chat.roomId).catch((error: unknown) =>
                          toast({
                            title: failureText(error, 'Could not unarchive the room.'),
                            variant: 'destructive',
                          })
                        )
                      }
                    >
                      Unarchive
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </ArchivedFold>
        </div>
      )}
    </ServerPage>
  );
});

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
  workspaceId,
  fold,
}: {
  group: RoomGroup;
  serverId: string;
  workspaceId: string;
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
          <MessagesSquare className="size-4 text-foreground-muted" />
        )}
        <span className="truncate text-sm font-medium text-foreground">{group.label}</span>
        <span className="shrink-0 text-xs text-foreground-muted">
          {group.rooms.length} {group.rooms.length === 1 ? 'room' : 'rooms'}
        </span>
      </button>

      {open && (
        <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
          {shown.map((room) => (
            <RoomRow key={room.id} room={room} serverId={serverId} workspaceId={workspaceId} />
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
  workspaceId,
}: {
  room: RemoteRoomSummary;
  serverId: string;
  workspaceId: string;
}) {
  const members = switchRoomsStore.localMemberIds(room.id);
  const { data: remoteAgents } = useWorkspaceAgents(workspaceId);
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
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{roomTitle(room)}</span>
          <UnreadBadge roomId={room.id} />
        </span>
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
                      serverId={serverId}
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
