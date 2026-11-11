import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DoorOpen, Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { useArchiveRoomConfirm } from '@renderer/features/switch-rooms/archive-room-confirm';
import { openRoom } from '@renderer/features/switch-rooms/open-room';
import { roomDetailKey } from '@renderer/features/switch-rooms/room-participants';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { FilterSelect } from '@renderer/lib/components/filter-select';
import { LIST_PAGE_WIDTH, ListToolbar } from '@renderer/lib/components/list-toolbar';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';
import { AppMark, RoomCard } from './room-card';
import { allReadableRooms, isConsoleGroupChatSummary, withConsoleGroupChats } from './room-filters';
import {
  appOptions,
  filterRoomCards,
  groupOptions,
  NO_FILTER,
  offeredFilter,
  type RoomCard as RoomCardData,
  type RoomsFilter,
  roomCard,
} from './room-list';
import { ServerPage, ServerTableEmpty } from './server-page';
import { ServerSectionTitlebar } from './server-section-titlebar';
import { switchRoomsStore } from './switch-rooms-store';
import { switchServersStore } from './switch-servers-store';
import { useListedRoomsInWorkspace, useReadableRoomsInWorkspace } from './use-listed-rooms';

function useServerId(): string {
  return useParams('serverRooms').params.serverId;
}

const ServerRoomsTitlebar = observer(function ServerRoomsTitlebar() {
  return <ServerSectionTitlebar serverId={useServerId()} icon={DoorOpen} label="Rooms" />;
});

type Scope = 'mine' | 'all';
type State = 'active' | 'archived';

const SCOPES = [
  { value: 'mine', label: 'Mine' },
  { value: 'all', label: 'All rooms' },
] as const satisfies readonly { value: Scope; label: string }[];

const STATES = [
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
] as const satisfies readonly { value: State; label: string }[];

/**
 * The workspace's rooms as cards: yours by default, every room you can read
 * at a switch, and the archived ones at another. The same card whichever
 * slice you look at.
 */
const ServerRoomsPanel = observer(function ServerRoomsPanel() {
  const serverId = useServerId();
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  const showCreateRoomModal = useShowModal('createRoomModal');
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<Scope>('mine');
  const [state, setState] = useState<State>('active');
  const [picked, setFilter] = useState<RoomsFilter>(NO_FILTER);
  const confirmArchive = useArchiveRoomConfirm();

  useEffect(() => {
    void refreshSidebarRoomState(false);
  }, [serverId]);

  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  const viewerId = switchServersStore.statusFor(serverId)?.user?.id ?? null;
  const listed = useListedRoomsInWorkspace(workspaceId);
  const all = allReadableRooms(listed, useReadableRoomsInWorkspace(workspaceId));
  const signedOut = switchRoomsStore.workspacesNotSignedIn.some((w) => w.id === workspaceId);
  const failed = switchRoomsStore.workspacesThatFailedToLoad.some((w) => w.id === workspaceId);
  // On a server Console runs, the sidebar lists every room, so only the
  // server's word says which are yours. Elsewhere what the sidebar lists as
  // yours counts too, for a server that does not say.
  const listedIds = server?.managed ? undefined : new Set(listed.map((room) => room.id));

  // Archived rooms in a messaging app come from the server; archived group
  // chats from the chats list, which follows the active workspace.
  const archivedRoomsQuery = useQuery({
    queryKey: ['archived-rooms', workspaceId],
    queryFn: async () => {
      const found = await rpc.workspaces.listArchivedRooms({ workspaceId: workspaceId as string });
      switchRoomsStore.noteRooms(workspaceId as string, found);
      return found.filter((room) => !room.isConsoleChat);
    },
    enabled: workspaceId !== null && !signedOut,
  });
  const chatsHere = chatsStore.serverId === serverId;
  const archivedChats = chatsHere
    ? [...chatsStore.archived.values()].filter(isConsoleGroupChatSummary)
    : [];

  const toCard = (room: RemoteRoomSummary): RoomCardData => {
    const card = roomCard(room, { id: viewerId, listedIds });
    // On a server from before room lists counted a chat's members, the chat
    // list knows them. A chat made a channel on an app keeps the server's
    // count, of the app's accounts, as the gateway shows it.
    const chat =
      room.isConsoleChat && card.peopleCount === null
        ? (chatsStore.chats.get(room.id) ?? chatsStore.archived.get(room.id))
        : undefined;
    return chat && chat.memberCount > 0 ? { ...card, peopleCount: chat.memberCount } : card;
  };
  const activeCards = all.map(toCard);
  const archivedCards = [
    ...(archivedRoomsQuery.data ?? []).map(toCard),
    ...withConsoleGroupChats([], archivedChats).map((room) => ({
      ...toCard(room),
      archived: true,
    })),
  ];
  const cards = (state === 'archived' ? archivedCards : activeCards).filter(
    (card) => scope === 'all' || card.mine
  );
  const apps = appOptions(cards);
  const groups = groupOptions(cards);
  const filter = offeredFilter(picked, apps, groups);
  const shown = filterRoomCards(cards, filter);
  const archivedError =
    state === 'archived' &&
    (archivedRoomsQuery.isError || (chatsHere && chatsStore.archivedError !== null));

  const summaries = new Map(
    [...all, ...(archivedRoomsQuery.data ?? [])].map((room) => [room.id, room] as const)
  );
  const archivedSummary = (card: RoomCardData) => summaries.get(card.id);
  const mayArchive = (card: RoomCardData): boolean => {
    if (card.isConsoleChat)
      return (
        (card.archived ? chatsStore.archived.get(card.id) : chatsStore.chats.get(card.id))
          ?.canManage ?? false
      );
    const room = archivedSummary(card);
    return room !== undefined && workspaceId !== null
      ? switchRoomsStore.roomPermissions(workspaceId, room).canWrite
      : false;
  };
  async function setArchived(card: RoomCardData) {
    if (workspaceId === null) return;
    const archived = !card.archived;
    try {
      if (card.isConsoleChat) {
        if (archived) await chatsStore.archive(serverId, card.id);
        else await chatsStore.unarchive(serverId, card.id);
      } else {
        const updated = await rpc.workspaces.setRoomArchived({
          workspaceId,
          roomId: card.id,
          archived,
        });
        // The room's page reads its detail from the cache: give it the answer, as its own Archive does.
        queryClient.setQueryData(roomDetailKey(workspaceId, card.id), updated);
        await queryClient.invalidateQueries({ queryKey: ['archived-rooms', workspaceId] });
        await switchRoomsStore.refreshRoomState();
      }
      void refreshSidebarRoomState(true);
    } catch (error) {
      toast({
        title: failureText(
          error,
          archived ? 'Could not archive the room.' : 'Could not unarchive the room.'
        ),
        variant: 'destructive',
      });
    }
  }

  return (
    <ServerPage
      width={LIST_PAGE_WIDTH}
      title="Rooms"
      description={
        scope === 'mine'
          ? 'Rooms you own, take part in, or have an agent in.'
          : `Every room on ${server?.name ?? 'this server'} you can see.`
      }
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
      {/* Four ways to have no rooms to show, and only one of them means
        "there are no rooms". Saying that in the others would send someone off
        to create a room they already have. */}
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
      ) : (
        <div className="flex flex-col gap-4">
          <ListToolbar
            scope={
              <SegmentedControl
                ariaLabel="Whose rooms"
                value={scope}
                onChange={setScope}
                options={SCOPES}
              />
            }
            search={
              <SearchInput
                containerClassName="w-full"
                value={filter.query}
                onChange={(e) => setFilter({ ...filter, query: e.target.value })}
                placeholder="Search rooms…"
                aria-label="Search rooms by name"
              />
            }
            filters={
              <>
                <FilterSelect
                  label="Messaging app"
                  anyLabel="Any messaging app"
                  value={filter.app}
                  options={apps.map((app) => ({
                    value: app.value,
                    label: app.label,
                    icon: <AppMark bridgeType={app.bridgeType} />,
                  }))}
                  onChange={(app) => setFilter({ ...filter, app })}
                />
                <FilterSelect
                  label="Group"
                  anyLabel="Any group"
                  value={filter.groupId}
                  options={groups.map((group) => ({ value: group.id, label: group.name }))}
                  onChange={(groupId) => setFilter({ ...filter, groupId })}
                />
                <SegmentedControl
                  ariaLabel="Active or archived rooms"
                  value={state}
                  onChange={setState}
                  options={STATES}
                />
              </>
            }
          />
          {archivedError && (
            <p className="text-xs text-destructive">
              {archivedRoomsQuery.isError
                ? failureText(archivedRoomsQuery.error, 'Could not list the archived rooms.')
                : chatsStore.archivedError}
            </p>
          )}
          {shown.length === 0 ? (
            // While the archived rooms load, or after they failed, "none" would be a claim.
            state === 'archived' && archivedRoomsQuery.isPending && !signedOut ? (
              <p className="py-2 text-sm text-foreground-muted">Loading archived rooms…</p>
            ) : archivedError ? null : (
              <p className="py-2 text-sm text-foreground-muted">
                {emptyText({ rooms: cards.length, scope, state, query: filter.query })}
              </p>
            )
          ) : (
            <div
              role="list"
              aria-label="Rooms"
              className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-[14px]"
            >
              {shown.map((card) => (
                <div role="listitem" key={card.id}>
                  <RoomCard
                    card={card}
                    unread={chatsStore.unread(card.id)}
                    showYours={scope === 'all'}
                    onOpen={() => void openRoom(card.id)}
                    onArchive={
                      mayArchive(card)
                        ? () =>
                            card.archived
                              ? void setArchived(card)
                              : confirmArchive.request(card.name, () => void setArchived(card))
                        : null
                    }
                  />
                </div>
              ))}
            </div>
          )}
          {confirmArchive.dialog}
        </div>
      )}
    </ServerPage>
  );
});

/** What an empty page means, which depends on why it is empty. */
export function emptyText({
  rooms,
  scope,
  state,
  query,
}: {
  rooms: number;
  scope: Scope;
  state: State;
  query: string;
}): string {
  if (rooms > 0) return query.trim() ? `No room matches “${query.trim()}”.` : 'No room matches.';
  if (state === 'archived') return 'No archived rooms.';
  return scope === 'mine'
    ? 'You are in no rooms yet. Create one, or choose All rooms to see the rest.'
    : 'No rooms here yet. Create one to give your agents somewhere to work.';
}

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
