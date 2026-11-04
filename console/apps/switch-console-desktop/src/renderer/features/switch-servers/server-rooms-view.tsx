import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DoorOpen, Lock, MessagesSquare, Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { UnreadBadge } from '@renderer/features/chats/components/unread-badge';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { openRoom } from '@renderer/features/switch-rooms/open-room';
import { ACCESS_LABELS } from '@renderer/features/switch-rooms/room-settings-sections';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { LIST_PAGE_WIDTH, ListToolbar } from '@renderer/lib/components/list-toolbar';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';
import { allReadableRooms, isConsoleGroupChatSummary, withConsoleGroupChats } from './room-filters';
import {
  ACCESS_SHORT,
  appOptions,
  filterRoomRows,
  groupOptions,
  NO_FILTER,
  type RoomRow,
  type RoomsFilter,
  roomRow,
} from './rooms-table';
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

const ANY = '__any__';

/**
 * The workspace's rooms as one table: yours by default, every room you can
 * read at a switch, and the archived ones at another. The same row whichever
 * slice you look at, so moving between them never changes what a column
 * means.
 */
const ServerRoomsPanel = observer(function ServerRoomsPanel() {
  const serverId = useServerId();
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  const showCreateRoomModal = useShowModal('createRoomModal');
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<Scope>('mine');
  const [state, setState] = useState<State>('active');
  const [filter, setFilter] = useState<RoomsFilter>(NO_FILTER);

  useEffect(() => {
    void refreshSidebarRoomState(false);
  }, [serverId]);

  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  const viewerId = switchServersStore.statusFor(serverId)?.user?.id ?? null;
  const yours = useListedRoomsInWorkspace(workspaceId);
  const all = allReadableRooms(yours, useReadableRoomsInWorkspace(workspaceId));
  const signedOut = switchRoomsStore.workspacesNotSignedIn.some((w) => w.id === workspaceId);
  const failed = switchRoomsStore.workspacesThatFailedToLoad.some((w) => w.id === workspaceId);

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
  const archivedChats =
    chatsStore.serverId === serverId
      ? [...chatsStore.archived.values()].filter(isConsoleGroupChatSummary)
      : [];

  const toRow = (room: RemoteRoomSummary): RoomRow => {
    const row = roomRow(room, viewerId);
    // A chat's people are its members, which the chat list knows.
    const chat = room.isConsoleChat ? chatsStore.chats.get(room.id) : undefined;
    return chat ? { ...row, peopleCount: chat.memberCount } : row;
  };
  const activeRows = (scope === 'all' ? all : yours).map(toRow);
  const archivedRows = [
    ...(archivedRoomsQuery.data ?? []).map(toRow),
    ...withConsoleGroupChats([], archivedChats).map((room) => ({
      ...toRow(room),
      archived: true,
    })),
  ].filter((row) => scope === 'all' || row.mine);
  const rows = state === 'archived' ? archivedRows : activeRows;
  const shown = filterRoomRows(rows, filter);
  const apps = appOptions(rows);
  const groups = groupOptions(rows);

  async function unarchive(row: RoomRow) {
    if (workspaceId === null) return;
    try {
      if (row.isConsoleChat) {
        await chatsStore.unarchive(serverId, row.id);
      } else {
        await rpc.workspaces.setRoomArchived({ workspaceId, roomId: row.id, archived: false });
        await queryClient.invalidateQueries({ queryKey: ['archived-rooms', workspaceId] });
        await switchRoomsStore.refreshRoomState();
      }
      void refreshSidebarRoomState(true);
    } catch (error) {
      toast({ title: failureText(error, 'Could not unarchive the room.'), variant: 'destructive' });
    }
  }
  const mayUnarchive = (row: RoomRow): boolean => {
    if (row.isConsoleChat) return chatsStore.archived.get(row.id)?.canManage ?? false;
    const room = (archivedRoomsQuery.data ?? []).find((each) => each.id === row.id);
    return room !== undefined && workspaceId !== null
      ? switchRoomsStore.roomPermissions(workspaceId, room).canWrite
      : false;
  };

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
      ) : (
        <div className="flex flex-col gap-4">
          <ListToolbar
            scope={
              <SegmentedControl
                ariaLabel="Whose rooms"
                value={scope}
                onChange={(next) => {
                  setScope(next);
                  setFilter((current) => ({ ...current, app: null, groupId: null }));
                }}
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
                  options={apps.map((app) => ({ value: app, label: app }))}
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
          {state === 'archived' && archivedRoomsQuery.isError && (
            <p className="text-xs text-destructive">
              {failureText(archivedRoomsQuery.error, 'Could not list the archived rooms.')}
            </p>
          )}
          {shown.length === 0 ? (
            <p className="py-2 text-sm text-foreground-muted">
              {emptyText({ rows: rows.length, scope, state, query: filter.query })}
            </p>
          ) : (
            <RoomsTable
              rows={shown}
              scope={scope}
              unarchive={state === 'archived' ? unarchive : null}
              mayUnarchive={mayUnarchive}
            />
          )}
        </div>
      )}
    </ServerPage>
  );
});

/** What an empty table means, which depends on why it is empty. */
export function emptyText({
  rows,
  scope,
  state,
  query,
}: {
  rows: number;
  scope: Scope;
  state: State;
  query: string;
}): string {
  if (rows > 0) return query.trim() ? `No room matches “${query.trim()}”.` : 'No room matches.';
  if (state === 'archived') return 'No archived rooms.';
  return scope === 'mine'
    ? 'You are in no rooms yet. Create one, or choose All rooms to see the rest.'
    : 'No rooms here yet. Create one to give your agents somewhere to work.';
}

function FilterSelect({
  label,
  anyLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  anyLabel: string;
  value: string | null;
  options: { value: string; label: string }[];
  onChange: (next: string | null) => void;
}) {
  const current = options.find((option) => option.value === value)?.label ?? anyLabel;
  return (
    <Select
      value={value ?? ANY}
      onValueChange={(next) => onChange(next === ANY ? null : (next as string))}
    >
      <SelectTrigger size="sm" className="w-auto min-w-[150px]" aria-label={label}>
        <SelectValue>{current}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{anyLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const RoomsTable = observer(function RoomsTable({
  rows,
  scope,
  unarchive,
  mayUnarchive,
}: {
  rows: RoomRow[];
  scope: Scope;
  /** The way to unarchive a row, in the archived view. */
  unarchive: ((row: RoomRow) => Promise<void>) | null;
  mayUnarchive: (row: RoomRow) => boolean;
}) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-foreground-muted">
            <th className="px-3 py-2 font-normal">Room</th>
            <th className="px-3 py-2 font-normal">Messaging app</th>
            <th className="px-3 py-2 font-normal">Group</th>
            <th className="px-3 py-2 font-normal">Owner</th>
            <th className="px-3 py-2 font-normal">Access</th>
            <th className="px-3 py-2 font-normal">Agents · people</th>
            <th className="px-3 py-2 font-normal">Created</th>
            {unarchive && <th className="px-3 py-2" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              onClick={() => void openRoom(row.id)}
              className="cursor-pointer border-b border-border last:border-b-0 hover:bg-[var(--fill)]"
            >
              <td className="px-3 py-2">
                <span className="flex min-w-0 items-center gap-2">
                  <RoomMark row={row} />
                  <span
                    className={cn(
                      'truncate',
                      // In All rooms, yours stand out; the rest are there to find.
                      scope === 'all' && !row.mine
                        ? 'text-foreground-muted'
                        : 'font-medium text-foreground'
                    )}
                  >
                    {row.name}
                  </span>
                  <UnreadBadge roomId={row.id} />
                </span>
              </td>
              <td className="px-3 py-2 text-foreground">{row.appLabel}</td>
              <td className="px-3 py-2 text-foreground">{row.groupName ?? '—'}</td>
              <td className="px-3 py-2 text-foreground">{row.ownerLabel ?? '—'}</td>
              <td className="px-3 py-2 text-foreground">
                {row.access ? (
                  <Tooltip>
                    <TooltipTrigger render={<span>{ACCESS_SHORT[row.access]}</span>} />
                    <TooltipContent>{ACCESS_LABELS[row.access]}</TooltipContent>
                  </Tooltip>
                ) : (
                  '—'
                )}
              </td>
              <td className="px-3 py-2 text-foreground tabular-nums">
                {row.agentCount} · {row.peopleCount ?? '—'}
              </td>
              <td className="px-3 py-2 text-foreground-muted">
                {row.createdAt ? <AbsoluteDate value={row.createdAt} /> : '—'}
              </td>
              {unarchive && (
                <td className="px-3 py-2 text-right">
                  {mayUnarchive(row) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(event) => {
                        event.stopPropagation();
                        void unarchive(row);
                      }}
                    >
                      Unarchive
                    </Button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

/** Where the room lives at a glance: its app's mark, or a lock for one only its people reach. */
function RoomMark({ row }: { row: RoomRow }) {
  if (row.privateChannel && !row.isConsoleChat) {
    return (
      <Lock className="size-3.5 shrink-0 text-foreground-muted" aria-label="Private channel" />
    );
  }
  if (hasBridgeIcon(row.bridgeType)) {
    return <BridgeIcon bridgeType={row.bridgeType} size={14} className="shrink-0" />;
  }
  return <MessagesSquare className="size-3.5 shrink-0 text-foreground-muted" />;
}

/** A day, with the year only when it is not this one. */
function AbsoluteDate({ value }: { value: string }) {
  const date = new Date(
    value.includes('T') || value.includes('Z') ? value : value.replace(' ', 'T')
  );
  if (Number.isNaN(date.getTime())) return <>—</>;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return (
    <time dateTime={date.toISOString()}>
      {date.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        ...(sameYear ? {} : { year: 'numeric' }),
      })}
    </time>
  );
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
