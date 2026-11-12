import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  DoorOpen,
  ExternalLink,
  Library,
  Loader2,
  Package,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { openRoom } from '@renderer/features/switch-rooms/open-room';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { useReadableRoomsInWorkspace } from '@renderer/features/switch-servers/use-listed-rooms';
import { administersWorkspaceInScope } from '@renderer/features/switch-servers/workspace-admin';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { PageHeader } from '@renderer/lib/components/page-header';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import {
  Dialog,
  DialogContent,
  DialogContentArea,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Input } from '@renderer/lib/ui/input';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import type {
  LibraryDocument,
  LibraryItem,
  LibraryKind,
} from '@shared/core/switch-servers/library';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';
import { changesOf, formOf, formProblem, type LibraryForm } from './library-form';
import { LibraryItemFields } from './library-item-form';
import {
  accessOf,
  hiddenRoomsText,
  KIND_TEXT,
  LIBRARY_ACCESS_OPTIONS,
  libraryPermissions,
  ownerText,
} from './library-model';
import {
  invalidateLibrary,
  libraryItemKey,
  libraryRoomsKey,
  referenceTypesKey,
} from './library-queries';
import { PackageMembers } from './package-members';

function useViewParams() {
  return useParams('libraryItem').params;
}

const LibraryItemTitlebar = observer(function LibraryItemTitlebar() {
  const { serverId, kind, itemId } = useViewParams();
  const { navigate } = useNavigate();
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  // The panel reads the same item, so this is answered from its cache.
  const item = useQuery({
    queryKey: libraryItemKey(workspaceId ?? '', kind, itemId),
    queryFn: () =>
      rpc.workspaces.getLibraryItem({ workspaceId: workspaceId as string, kind, itemId }),
    enabled: workspaceId !== null,
  });
  return (
    <ServerSectionTitlebar
      serverId={serverId}
      icon={Library}
      label="Resources"
      onSectionClick={() => navigate('library', { serverId, kind })}
      item={{ label: item.data?.name ?? KIND_TEXT[kind].Noun }}
    />
  );
});

/**
 * One reference or document: what it is, changed in place by whoever may, the
 * rooms it is attached to, and attaching it to more from here.
 */
const LibraryItemPanel = observer(function LibraryItemPanel() {
  const { serverId, kind, itemId } = useViewParams();
  const { navigate } = useNavigate();
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  const viewer = {
    id: switchServersStore.statusFor(serverId)?.user?.id ?? null,
    isAdmin: administersWorkspaceInScope(serverId),
  };
  const item = useQuery({
    queryKey: libraryItemKey(workspaceId ?? '', kind, itemId),
    queryFn: () =>
      rpc.workspaces.getLibraryItem({ workspaceId: workspaceId as string, kind, itemId }),
    enabled: workspaceId !== null,
  });
  const showDelete = useShowModal('deleteLibraryItemModal');
  const [editing, setEditing] = useState(false);
  const text = KIND_TEXT[kind];

  const back = (
    <Button
      size="sm"
      variant="ghost"
      className="-ml-2"
      onClick={() => navigate('library', { serverId, kind })}
    >
      <ArrowLeft className="size-4" /> All {text.title.toLowerCase()}
    </Button>
  );

  if (workspaceId === null || item.isError) {
    return (
      <Page>
        <PageHeader sticky title={text.Noun} back={back} />
        <p className="text-sm text-destructive">
          {workspaceId === null
            ? 'This server has no workspace yet, so its resources cannot be read.'
            : failureText(item.error, `Could not read this ${text.noun}.`)}
        </p>
      </Page>
    );
  }
  if (item.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-foreground-muted" />
      </div>
    );
  }

  const data = item.data;
  const permissions = libraryPermissions(data, viewer);
  const access = accessOf(data);
  const accessHint = LIBRARY_ACCESS_OPTIONS.find((o) => o.value === access)?.hint;
  const owner = ownerText(data, viewer.id);

  return (
    <Page>
      <PageHeader
        sticky
        title={data.name}
        description={
          <span className="flex flex-col gap-1.5">
            <span>{data.description || 'No description.'}</span>
            <span className="flex flex-wrap items-center gap-2 text-xs text-foreground-passive">
              {owner && (
                <>
                  <span>{owner}</span>
                  <span>·</span>
                </>
              )}
              <span>{accessHint}</span>
            </span>
          </span>
        }
        back={back}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{data.typeLabel ?? text.Noun}</Badge>
          <span className="flex-1" />
          {permissions.canEdit && !editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" />
              Edit
            </Button>
          )}
          {permissions.canDelete && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                showDelete({
                  workspaceId,
                  item: data,
                  onSuccess: () => navigate('library', { serverId, kind }),
                })
              }
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          )}
        </div>
      </PageHeader>

      {editing ? (
        <EditForm
          workspaceId={workspaceId}
          item={data}
          canChangeAccess={permissions.canChangeAccess}
          onDone={() => setEditing(false)}
        />
      ) : (
        <ItemBody item={data} />
      )}

      {data.kind === 'packages' && (
        <PackageMembers
          serverId={serverId}
          workspaceId={workspaceId}
          pkg={data}
          canEdit={permissions.canEdit}
          viewer={viewer}
        />
      )}
      <RoomsSection workspaceId={workspaceId} item={data} />
      {data.packageIds.length > 0 && <PackagesLine workspaceId={workspaceId} item={data} />}
    </Page>
  );
});

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-auto bg-background">
      <div className="mx-auto w-full max-w-[820px] space-y-7 px-8 pb-10">{children}</div>
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2.5">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function ItemBody({ item }: { item: LibraryItem | LibraryDocument }) {
  return (
    <>
      {item.kind === 'references' && (
        <Section title="Links">
          {item.urls.length === 0 ? (
            <p className="text-sm text-foreground-muted">No links.</p>
          ) : (
            <List>
              {item.urls.map((url) => (
                <button
                  key={url}
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-2.5 text-left text-sm hover:bg-background-1"
                  onClick={() => void openExternalUrl(url, 'Could not open the link')}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{url}</span>
                  <ExternalLink className="size-3.5 shrink-0 text-foreground-muted" />
                </button>
              ))}
            </List>
          )}
        </Section>
      )}
      <Section title="Instructions for agents">
        {item.instructions ? (
          <p className="text-sm whitespace-pre-wrap text-foreground">{item.instructions}</p>
        ) : (
          <p className="text-sm text-foreground-muted">None.</p>
        )}
      </Section>
      {'content' in item && (
        <Section title="Content">
          {item.content.trim() ? (
            <div className="rounded-[11px] border border-border px-4 py-3">
              <MarkdownRenderer content={item.content} variant="compact" />
            </div>
          ) : (
            <p className="text-sm text-foreground-muted">Empty.</p>
          )}
        </Section>
      )}
    </>
  );
}

function EditForm({
  workspaceId,
  item,
  canChangeAccess,
  onDone,
}: {
  workspaceId: string;
  item: LibraryItem | LibraryDocument;
  canChangeAccess: boolean;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [initial] = useState<LibraryForm>(() => formOf(item));
  const [form, setForm] = useState<LibraryForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const types = useQuery({
    queryKey: referenceTypesKey(workspaceId),
    queryFn: () => rpc.workspaces.listReferenceTypes({ workspaceId }),
    enabled: item.kind === 'references',
  });
  const changes = changesOf(item.kind, initial, form);
  const changed = Object.keys(changes).length > 0;
  const problem = formProblem(item.kind, form);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await rpc.workspaces.updateLibraryItem({
        workspaceId,
        kind: item.kind,
        itemId: item.id,
        changes,
      });
      await invalidateLibrary(queryClient, workspaceId, item.kind);
      toast({ title: 'Saved' });
      onDone();
    } catch (e) {
      setError(failureText(e, 'Could not save the changes.'));
      setSaving(false);
    }
  };

  return (
    <section
      aria-label="Edit"
      className="flex flex-col gap-4 rounded-[11px] border border-border p-4"
    >
      <LibraryItemFields
        kind={item.kind}
        form={form}
        onChange={setForm}
        types={types.data ?? []}
        typeLocked
        canChangeAccess={canChangeAccess}
      />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center justify-end gap-2">
        {problem && <span className="mr-auto text-xs text-foreground-muted">{problem}</span>}
        <Button size="sm" variant="outline" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={saving || !changed || problem !== null}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </section>
  );
}

const RoomsSection = observer(function RoomsSection({
  workspaceId,
  item,
}: {
  workspaceId: string;
  item: LibraryItem;
}) {
  const queryClient = useQueryClient();
  const rooms = useQuery({
    queryKey: libraryRoomsKey(workspaceId, item.kind, item.id),
    queryFn: () =>
      rpc.workspaces.listLibraryItemRooms({ workspaceId, kind: item.kind, itemId: item.id }),
  });
  const readable = useReadableRoomsInWorkspace(workspaceId);
  const summaries = new Map(readable.map((room) => [room.id, room]));
  // Rooms it is in that you cannot open: counted for its owner and admins, never named.
  const hidden = item.hiddenRoomsCount ?? 0;
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attachedIds = new Set((rooms.data ?? []).map((room) => room.roomId));
  const mayAttach = (room: RemoteRoomSummary) =>
    switchRoomsStore.roomPermissions(workspaceId, room).canWrite;
  const attachable = readable.filter(
    (room) => !room.archived && !attachedIds.has(room.id) && mayAttach(room)
  );

  async function detach(roomId: string, roomName: string) {
    setBusy(roomId);
    setError(null);
    try {
      await rpc.workspaces.setRoomResourceAttached({
        workspaceId,
        roomId,
        kind: item.kind,
        resourceId: item.id,
        attached: false,
      });
      await invalidateLibrary(queryClient, workspaceId, item.kind);
    } catch (cause) {
      setError(failureText(cause, `Could not detach it from ${roomName}.`));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section
      title="Rooms"
      action={
        attachable.length > 0 && (
          <Button size="sm" variant="outline" onClick={() => setPicking(true)}>
            <Plus className="size-3.5" />
            Attach to rooms
          </Button>
        )
      }
    >
      {rooms.isPending ? (
        <Loader2 className="size-4 animate-spin text-foreground-muted" />
      ) : rooms.isError ? (
        <p className="text-xs text-destructive">
          {failureText(rooms.error, 'Could not list the rooms it is in.')}
        </p>
      ) : rooms.data.length === 0 ? (
        <p className="text-sm text-foreground-muted">
          {hidden > 0
            ? `Only in ${hiddenRoomsText(hidden)}.`
            : 'Not attached to any room you can see. Attach it and the agents there can use it.'}
        </p>
      ) : (
        <>
          <List>
            {rooms.data.map((room) => {
              // The server says per room; an older one leaves it to the room's own rule.
              const summary = summaries.get(room.roomId);
              const mayDetach =
                room.canUnlink ??
                (summary !== undefined &&
                  switchRoomsStore.roomPermissions(workspaceId, summary).canUnlink);
              return (
                <div key={room.roomId} className="flex items-center gap-2 px-3.5 py-2.5">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
                    onClick={() => void openRoom(room.roomId)}
                  >
                    <DoorOpen className="size-4 shrink-0 text-foreground-muted" />
                    <span className="truncate text-sm text-foreground">{room.roomName}</span>
                  </button>
                  {mayDetach && (
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-label={`Detach from ${room.roomName}`}
                      title={`Detach from ${room.roomName}`}
                      disabled={busy === room.roomId}
                      onClick={() => void detach(room.roomId, room.roomName)}
                    >
                      {busy === room.roomId ? <Loader2 className="animate-spin" /> : 'Detach'}
                    </Button>
                  )}
                </div>
              );
            })}
          </List>
          {hidden > 0 && (
            <p className="text-xs text-foreground-muted">And {hiddenRoomsText(hidden)}.</p>
          )}
        </>
      )}
      {error !== null && <p className="text-xs text-destructive">{error}</p>}
      {picking && (
        <AttachToRoomsDialog
          workspaceId={workspaceId}
          item={item}
          rooms={attachable}
          onClose={() => setPicking(false)}
        />
      )}
    </Section>
  );
});

/** The rooms you may attach it to that do not have it yet, each attached with a click. */
function AttachToRoomsDialog({
  workspaceId,
  item,
  rooms,
  onClose,
}: {
  workspaceId: string;
  item: LibraryItem;
  rooms: RemoteRoomSummary[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const [done, setDone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needle = filter.trim().toLowerCase();
  const shown = rooms
    .filter((room) => !done.has(room.id))
    .filter((room) => !needle || room.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));

  async function attach(room: RemoteRoomSummary) {
    setBusy(room.id);
    setError(null);
    try {
      await rpc.workspaces.setRoomResourceAttached({
        workspaceId,
        roomId: room.id,
        kind: item.kind,
        resourceId: item.id,
        attached: true,
      });
      setDone((current) => new Set(current).add(room.id));
      await invalidateLibrary(queryClient, workspaceId, item.kind);
    } catch (cause) {
      setError(failureText(cause, `Could not attach it to ${room.name}.`));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Attach {item.name} to rooms</DialogTitle>
        </DialogHeader>
        <DialogContentArea className="flex flex-col gap-3 pt-0">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-foreground-muted" />
            <Input
              autoFocus
              className="pl-8"
              placeholder="Search rooms…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          {shown.length === 0 ? (
            <p className="text-sm text-foreground-muted">
              {needle ? 'No room matches.' : 'It is in every room you can attach it to.'}
            </p>
          ) : (
            <div className="flex max-h-80 flex-col overflow-y-auto">
              {shown.map((room) => (
                <div key={room.id} className="flex items-center gap-2 py-1.5">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-foreground">{room.name}</span>
                    {room.description && (
                      <span className="truncate text-xs text-foreground-muted">
                        {room.description}
                      </span>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void attach(room)}
                  >
                    {busy === room.id ? <Loader2 className="animate-spin" /> : 'Attach'}
                  </Button>
                </div>
              ))}
            </div>
          )}
          {error !== null && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={onClose}>
              Done
            </Button>
          </div>
        </DialogContentArea>
      </DialogContent>
    </Dialog>
  );
}

function PackagesLine({ workspaceId, item }: { workspaceId: string; item: LibraryItem }) {
  const packages = useQuery({
    queryKey: ['library', workspaceId, 'packages'],
    queryFn: () => rpc.workspaces.listLibrary({ workspaceId, kind: 'packages' }),
  });
  // Keyed by id: two packages may share a name.
  const named = item.packageIds.flatMap((id) => {
    const name = packages.data?.find((p) => p.id === id)?.name;
    return name === undefined ? [] : [{ id, name }];
  });
  const hidden = item.packageIds.length - named.length;
  return (
    <Section title="In packages">
      <div className="flex flex-wrap items-center gap-1.5">
        {named.map((pkg) => (
          <Badge key={pkg.id} variant="outline">
            <Package className="size-3" />
            {pkg.name}
          </Badge>
        ))}
        {hidden > 0 && !packages.isPending && (
          <span className="text-xs text-foreground-muted">
            {hidden === 1 ? 'and 1 you cannot see' : `and ${hidden} you cannot see`}
          </span>
        )}
      </div>
    </Section>
  );
}

function List({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
      {children}
    </div>
  );
}

export const libraryItemView = {
  WrapView: ({
    children,
  }: {
    children: React.ReactNode;
    serverId: string;
    kind: LibraryKind;
    itemId: string;
  }) => <>{children}</>,
  TitlebarSlot: LibraryItemTitlebar,
  MainPanel: LibraryItemPanel,
  canActivate: (params: unknown): GuardResult => {
    const p =
      typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
    if (
      typeof p.serverId !== 'string' ||
      typeof p.itemId !== 'string' ||
      (p.kind !== 'references' && p.kind !== 'documents' && p.kind !== 'packages')
    ) {
      return { ok: false, redirect: 'home', discardParams: true };
    }
    return { ok: true };
  },
} satisfies ViewDefinition<{ serverId: string; kind: LibraryKind; itemId: string }>;
