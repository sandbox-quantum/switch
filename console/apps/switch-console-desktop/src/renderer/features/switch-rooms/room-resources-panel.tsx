import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileText, Link2, Loader2, Package, Plus, Search, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useState } from 'react';
import { opensAsConsoleChat } from '@renderer/features/chats/console-chat-redirect';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { LOCKED_ROW_HINT, LockedMark, OpensMark } from '@renderer/features/library/row-access';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { administersWorkspaceById } from '@renderer/features/switch-servers/workspace-admin';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { openExternalUrl } from '@renderer/lib/open-external';
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
import type { RoomResource, RoomResourceKind } from '@shared/core/switch-servers/switch-servers';
import { useRoomDetail } from './room-participants';
import { attachableResources, opensInResources, resourcesByOrigin } from './room-resources';

const KIND_LABEL: Record<RoomResourceKind, { title: string; noun: string; none: string }> = {
  references: { title: 'References', noun: 'reference', none: 'No references attached.' },
  documents: { title: 'Documents', noun: 'document', none: 'No documents attached.' },
  packages: { title: 'Packages', noun: 'package', none: 'No packages attached.' },
};

const roomResourcesKey = (workspaceId: string, roomId: string, kind: RoomResourceKind) => [
  'room-resources',
  workspaceId,
  roomId,
  kind,
];
const linkedRoomsKey = (workspaceId: string, roomId: string) => [
  'room-linked-rooms',
  workspaceId,
  roomId,
];

/**
 * What the room's agents are given to work with, as the gateway shows it: the
 * library's references, documents and packages attached to the room, the
 * documents its agents wrote here, and the rooms it points at. Whoever may
 * change the room attaches, detaches and links; everyone else reads.
 */
export const RoomResourcesPanel = observer(function RoomResourcesPanel({
  roomId,
}: {
  roomId: string;
}) {
  const chat = chatsStore.chat(roomId);
  const workspaceId =
    switchRoomsStore.roomWorkspaceId(roomId) ?? (chat ? workspacesStore.activeId : null);
  const detail = useRoomDetail(workspaceId, roomId, true);
  if (workspaceId === null) {
    return <Centered>This room’s workspace is still loading.</Centered>;
  }
  const room = detail.data ?? null;
  // A Console chat's members may read it but only its managers change it.
  const permissions =
    opensAsConsoleChat(roomId) && chat
      ? {
          canWrite: chat.canManage,
          canChangeMembers: chat.canManage,
          canInviteAgents: chat.canManage,
          canManage: chat.canManage,
          canUnlink: chat.canManage,
        }
      : room !== null
        ? switchRoomsStore.roomPermissions(workspaceId, room)
        : {
            canWrite: false,
            canChangeMembers: false,
            canInviteAgents: false,
            canManage: false,
            canUnlink: false,
          };
  const canWrite = permissions.canWrite;
  const canUnlink = permissions.canUnlink;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-8 px-10 py-8">
        <ResourceSection
          workspaceId={workspaceId}
          roomId={roomId}
          kind="references"
          canWrite={canWrite}
          canUnlink={canUnlink}
        />
        <ResourceSection
          workspaceId={workspaceId}
          roomId={roomId}
          kind="documents"
          canWrite={canWrite}
          canUnlink={canUnlink}
        />
        <ResourceSection
          workspaceId={workspaceId}
          roomId={roomId}
          kind="packages"
          canWrite={canWrite}
          canUnlink={canUnlink}
        />
        <LinkedRoomsSection workspaceId={workspaceId} roomId={roomId} canWrite={canWrite} />
      </div>
    </div>
  );
});

const ResourceSection = observer(function ResourceSection({
  workspaceId,
  roomId,
  kind,
  canWrite,
  canUnlink,
}: {
  workspaceId: string;
  roomId: string;
  kind: RoomResourceKind;
  /** Attaching. */
  canWrite: boolean;
  /** Detaching, which the server keeps for those taking part and admins. */
  canUnlink: boolean;
}) {
  const queryClient = useQueryClient();
  const { navigate } = useNavigate();
  const serverId = workspacesStore.serverIdFor(workspaceId);
  // Who is looking, to tell which attached items their Resources page opens for.
  const viewer = {
    id: serverId ? (switchServersStore.statusFor(serverId)?.user?.id ?? null) : null,
    isAdmin: administersWorkspaceById(workspaceId),
  };
  const key = roomResourcesKey(workspaceId, roomId, kind);
  const attached = useQuery({
    queryKey: key,
    queryFn: () => rpc.workspaces.listRoomResources({ workspaceId, roomId, kind }),
  });
  // Packages say what came in with them, so a reference or document shows which package brought it.
  const packages = useQuery({
    queryKey: roomResourcesKey(workspaceId, roomId, 'packages'),
    queryFn: () => rpc.workspaces.listRoomResources({ workspaceId, roomId, kind: 'packages' }),
    enabled: kind !== 'packages',
  });
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<RoomResource | null>(null);
  const label = KIND_LABEL[kind];
  const packageNames = new Map((packages.data ?? []).map((p) => [p.id, p.name]));
  const { library, roomScoped } = resourcesByOrigin(attached.data ?? []);

  async function detach(resource: RoomResource) {
    setBusy(resource.id);
    setError(null);
    try {
      await rpc.workspaces.setRoomResourceAttached({
        workspaceId,
        roomId,
        kind,
        resourceId: resource.id,
        attached: false,
      });
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (cause) {
      setError(
        failureText(
          cause,
          resource.roomScoped
            ? `Could not delete ${resource.name}.`
            : `Could not detach ${resource.name}.`
        )
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label={label.title} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{label.title}</h2>
        {canWrite && (
          <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
            <Plus className="size-3.5" />
            Attach {label.noun}
          </Button>
        )}
      </div>
      {attached.isPending ? (
        <Loader2 className="size-4 animate-spin text-foreground-muted" />
      ) : attached.isError ? (
        <p className="text-xs text-destructive">
          {failureText(attached.error, `Could not list this room’s ${label.title.toLowerCase()}.`)}
        </p>
      ) : library.length === 0 && roomScoped.length === 0 ? (
        <p className="text-sm text-foreground-muted">{label.none}</p>
      ) : (
        <>
          {library.length > 0 && (
            <List>
              {library.map((resource) => (
                <ResourceRow
                  key={resource.id}
                  resource={resource}
                  // The server lists every package holding it; only those attached here brought it.
                  via={resource.packageIds.flatMap((id) => packageNames.get(id) ?? [])}
                  onOpen={
                    resource.urls[0]
                      ? () => void openExternalUrl(resource.urls[0]!, 'Could not open the link')
                      : kind === 'documents'
                        ? () => setReading(resource)
                        : // A package has nothing to read here: its page shows what it holds,
                          // when the viewer may open it (the server says per package).
                          kind === 'packages' &&
                            serverId !== null &&
                            opensInResources(resource, viewer)
                          ? () =>
                              navigate('libraryItem', {
                                serverId,
                                kind: 'packages',
                                itemId: resource.id,
                              })
                          : null
                  }
                  // A package the viewer may not open, which its owner keeps private.
                  locked={
                    kind === 'packages' && serverId !== null && !opensInResources(resource, viewer)
                  }
                  removeLabel={canUnlink ? `Detach ${resource.name}` : null}
                  busy={busy === resource.id}
                  onRemove={() => void detach(resource)}
                />
              ))}
            </List>
          )}
          {roomScoped.length > 0 && (
            <>
              <p className="text-xs text-foreground-muted">Written by agents in this room</p>
              <List>
                {roomScoped.map((resource) => (
                  <ResourceRow
                    key={resource.id}
                    resource={resource}
                    via={[]}
                    onOpen={() => setReading(resource)}
                    // Deleting an agent's document is for its author, the room's owner
                    // and admins: the server says per document, else detaching's rule.
                    removeLabel={
                      (resource.canRemove ?? canUnlink) ? `Delete ${resource.name}` : null
                    }
                    busy={busy === resource.id}
                    // It is deleted for everyone, with no undo, so it asks first.
                    confirm
                    onRemove={() => void detach(resource)}
                  />
                ))}
              </List>
            </>
          )}
        </>
      )}
      {error !== null && <p className="text-xs text-destructive">{error}</p>}
      {picking && (
        <AttachDialog
          workspaceId={workspaceId}
          roomId={roomId}
          kind={kind}
          attached={attached.data ?? []}
          onClose={() => setPicking(false)}
          onAttached={() => void queryClient.invalidateQueries({ queryKey: key })}
        />
      )}
      {reading && (
        <DocumentDialog
          workspaceId={workspaceId}
          roomId={roomId}
          document={reading}
          onClose={() => setReading(null)}
          onOpenInResources={
            serverId !== null && opensInResources(reading, viewer)
              ? () => {
                  setReading(null);
                  navigate('libraryItem', { serverId, kind: 'documents', itemId: reading.id });
                }
              : null
          }
        />
      )}
    </section>
  );
});

function ResourceRow({
  resource,
  via,
  onOpen,
  locked = false,
  removeLabel,
  busy,
  confirm = false,
  onRemove,
}: {
  resource: RoomResource;
  /** The packages that brought it in, by name. */
  via: string[];
  onOpen: (() => void) | null;
  /** Shown to the viewer but not theirs to open: dimmed and locked. */
  locked?: boolean;
  /** The remove button's label, or null for someone who may not remove it. */
  removeLabel: string | null;
  busy: boolean;
  /** Ask before removing: the first click arms it, the second removes. */
  confirm?: boolean;
  onRemove: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const Icon =
    resource.kind === 'packages' ? Package : resource.kind === 'documents' ? FileText : Link2;
  const meta = [
    resource.typeLabel,
    resource.createdByAgentName ? `by ${resource.createdByAgentName}` : null,
    ...via.map((name) => `via ${name}`),
  ].filter(Boolean);
  const body = (
    <>
      <Icon className="size-4 shrink-0 text-foreground-muted" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={`flex items-center gap-1.5 truncate text-sm ${locked ? 'text-foreground-muted' : 'text-foreground'}`}
        >
          {resource.name}
          {resource.urls[0] && <ExternalLink className="size-3 shrink-0 text-foreground-muted" />}
          {locked && <LockedMark />}
        </span>
        {(resource.description || meta.length > 0) && (
          <span className="truncate text-xs text-foreground-muted">
            {[...meta, resource.description].filter(Boolean).join(' · ')}
          </span>
        )}
      </span>
    </>
  );
  return (
    <div className="flex items-center gap-2 px-3.5 py-2.5">
      {onOpen ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
          onClick={onOpen}
        >
          {body}
          {/* A link already shows where it goes; anything else opens here. */}
          {!resource.urls[0] && <OpensMark />}
        </button>
      ) : (
        <div
          className="flex min-w-0 flex-1 items-center gap-3"
          title={locked ? LOCKED_ROW_HINT : undefined}
        >
          {body}
        </div>
      )}
      {removeLabel && confirm && armed && (
        <span className="flex shrink-0 items-center gap-1">
          <span className="text-xs text-foreground-muted">Delete for everyone?</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setArmed(false)}>
            No
          </Button>
          <Button size="sm" variant="destructive" disabled={busy} onClick={onRemove}>
            {busy ? <Loader2 className="animate-spin" /> : 'Delete'}
          </Button>
        </span>
      )}
      {removeLabel && !(confirm && armed) && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={removeLabel}
          title={removeLabel}
          disabled={busy}
          onClick={confirm ? () => setArmed(true) : onRemove}
        >
          {busy ? <Loader2 className="animate-spin" /> : <X />}
        </Button>
      )}
    </div>
  );
}

/** The library's items of one kind not yet attached, each attached with a click. */
const AttachDialog = observer(function AttachDialog({
  workspaceId,
  roomId,
  kind,
  attached,
  onClose,
  onAttached,
}: {
  workspaceId: string;
  roomId: string;
  kind: RoomResourceKind;
  attached: RoomResource[];
  onClose: () => void;
  onAttached: () => void;
}) {
  const library = useQuery({
    queryKey: ['library', workspaceId, kind],
    queryFn: () => rpc.workspaces.listLibrary({ workspaceId, kind }),
  });
  const [filter, setFilter] = useState('');
  const [done, setDone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = KIND_LABEL[kind];
  const shown = attachableResources(library.data ?? [], attached, filter).filter(
    (resource) => !done.has(resource.id)
  );

  async function attach(resource: RoomResource) {
    setBusy(resource.id);
    setError(null);
    try {
      await rpc.workspaces.setRoomResourceAttached({
        workspaceId,
        roomId,
        kind,
        resourceId: resource.id,
        attached: true,
      });
      setDone((current) => new Set(current).add(resource.id));
      onAttached();
    } catch (cause) {
      setError(failureText(cause, `Could not attach ${resource.name}.`));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Attach a {label.noun}</DialogTitle>
        </DialogHeader>
        <DialogContentArea className="flex flex-col gap-3 pt-0">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-foreground-muted" />
            <Input
              autoFocus
              className="pl-8"
              placeholder={`Search ${label.title.toLowerCase()}…`}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          {library.isPending ? (
            <Loader2 className="size-4 animate-spin text-foreground-muted" />
          ) : library.isError ? (
            <p className="text-xs text-destructive">
              {failureText(library.error, `Could not list the ${label.title.toLowerCase()}.`)}
            </p>
          ) : shown.length === 0 ? (
            <p className="text-sm text-foreground-muted">
              {filter.trim()
                ? `No ${label.title.toLowerCase()} match.`
                : `Every ${label.noun} you can read is already attached.`}
            </p>
          ) : (
            <div className="flex max-h-80 flex-col overflow-y-auto">
              {shown.map((resource) => (
                <div key={resource.id} className="flex items-center gap-2 py-1.5">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-foreground">{resource.name}</span>
                    {(resource.typeLabel || resource.description) && (
                      <span className="truncate text-xs text-foreground-muted">
                        {[resource.typeLabel, resource.description].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void attach(resource)}
                  >
                    {busy === resource.id ? <Loader2 className="animate-spin" /> : 'Attach'}
                  </Button>
                </div>
              ))}
            </div>
          )}
          {error !== null && <p className="text-xs text-destructive">{error}</p>}
        </DialogContentArea>
      </DialogContent>
    </Dialog>
  );
});

function DocumentDialog({
  workspaceId,
  roomId,
  document,
  onClose,
  onOpenInResources,
}: {
  workspaceId: string;
  roomId: string;
  document: RoomResource;
  onClose: () => void;
  /** Opens a document from Resources on its own page there; null for one written in the room. */
  onOpenInResources: (() => void) | null;
}) {
  // The room's listing already carries the content; an older server's may not.
  const content = useQuery({
    queryKey: ['room-document', workspaceId, roomId, document.id],
    queryFn: () => rpc.workspaces.getRoomDocument({ workspaceId, roomId, documentId: document.id }),
    enabled: document.content === undefined,
    ...(document.content !== undefined
      ? {
          initialData: {
            id: document.id,
            name: document.name,
            description: document.description,
            content: document.content,
          },
        }
      : {}),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{document.name}</DialogTitle>
        </DialogHeader>
        <DialogContentArea className="flex flex-col gap-3 overflow-y-auto pt-0">
          {document.description && (
            <p className="text-sm text-foreground-muted">{document.description}</p>
          )}
          {content.isPending ? (
            <Loader2 className="size-4 animate-spin text-foreground-muted" />
          ) : content.isError ? (
            <p className="text-xs text-destructive">
              {failureText(content.error, 'Could not read this document.')}
            </p>
          ) : (
            <div className="rounded-md border border-border px-4 py-3">
              {content.data.content.trim() ? (
                <MarkdownRenderer content={content.data.content} variant="compact" />
              ) : (
                <p className="text-sm text-foreground-muted italic">Empty.</p>
              )}
            </div>
          )}
          {onOpenInResources && (
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={onOpenInResources}>
                Open in Resources
              </Button>
            </div>
          )}
        </DialogContentArea>
      </DialogContent>
    </Dialog>
  );
}

const LinkedRoomsSection = observer(function LinkedRoomsSection({
  workspaceId,
  roomId,
  canWrite,
}: {
  workspaceId: string;
  roomId: string;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const { navigate } = useNavigate();
  const key = linkedRoomsKey(workspaceId, roomId);
  const links = useQuery({
    queryKey: key,
    queryFn: () => rpc.workspaces.listLinkedRooms({ workspaceId, roomId }),
  });
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(targetRoomId: string, name: string) {
    setBusy(targetRoomId);
    setError(null);
    try {
      await rpc.workspaces.removeLinkedRoom({ workspaceId, roomId, targetRoomId });
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (cause) {
      setError(failureText(cause, `Could not unlink ${name}.`));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Linked rooms" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">Linked rooms</h2>
        {canWrite && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            Link a room
          </Button>
        )}
      </div>
      {links.isPending ? (
        <Loader2 className="size-4 animate-spin text-foreground-muted" />
      ) : links.isError ? (
        <p className="text-xs text-destructive">
          {failureText(links.error, 'Could not list the linked rooms.')}
        </p>
      ) : links.data.length === 0 ? (
        <p className="text-sm text-foreground-muted">This room points at no other rooms.</p>
      ) : (
        <List>
          {links.data.map((link) => (
            <div key={link.roomId} className="flex items-center gap-2 px-3.5 py-2.5">
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer flex-col text-left"
                onClick={() => navigate('room', { roomId: link.roomId })}
              >
                <span className="truncate text-sm text-foreground">{link.name}</span>
                <span className="truncate text-xs text-foreground-muted">
                  {[link.label, link.description].filter(Boolean).join(' · ')}
                </span>
              </button>
              {canWrite && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Unlink ${link.name}`}
                  title={`Unlink ${link.name}`}
                  disabled={busy === link.roomId}
                  onClick={() => void remove(link.roomId, link.name)}
                >
                  {busy === link.roomId ? <Loader2 className="animate-spin" /> : <X />}
                </Button>
              )}
            </div>
          ))}
        </List>
      )}
      {error !== null && <p className="text-xs text-destructive">{error}</p>}
      {adding && (
        <LinkRoomDialog
          workspaceId={workspaceId}
          roomId={roomId}
          linked={new Set((links.data ?? []).map((link) => link.roomId))}
          onClose={() => setAdding(false)}
          onLinked={() => void queryClient.invalidateQueries({ queryKey: key })}
        />
      )}
    </section>
  );
});

const LinkRoomDialog = observer(function LinkRoomDialog({
  workspaceId,
  roomId,
  linked,
  onClose,
  onLinked,
}: {
  workspaceId: string;
  roomId: string;
  linked: Set<string>;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = filter.trim().toLowerCase();
  const rooms = switchRoomsStore
    .readableRoomsInWorkspace(workspaceId)
    .filter((room) => room.id !== roomId && !linked.has(room.id) && !room.archived)
    .filter((room) => !query || room.name.toLowerCase().includes(query));

  async function save() {
    if (target === null || !label.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await rpc.workspaces.addLinkedRoom({
        workspaceId,
        roomId,
        targetRoomId: target,
        label: label.trim(),
      });
      onLinked();
      onClose();
    } catch (cause) {
      setError(failureText(cause, 'Could not link the room.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link a room</DialogTitle>
        </DialogHeader>
        <DialogContentArea className="flex flex-col gap-3 pt-0">
          <Input
            autoFocus
            placeholder="Search rooms…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="flex max-h-56 flex-col overflow-y-auto" role="listbox">
            {rooms.length === 0 ? (
              <p className="py-2 text-sm text-foreground-muted">No other rooms to link.</p>
            ) : (
              rooms.map((room) => (
                <button
                  key={room.id}
                  type="button"
                  role="option"
                  aria-selected={target === room.id}
                  className={
                    target === room.id
                      ? 'rounded-md bg-[var(--sel-soft)] px-2 py-1.5 text-left text-sm text-foreground'
                      : 'rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-background-1'
                  }
                  onClick={() => setTarget(room.id)}
                >
                  {room.name}
                </button>
              ))
            )}
          </div>
          <Input
            placeholder="Why they are linked, such as “support” or “depends on”"
            value={label}
            maxLength={200}
            onChange={(event) => setLabel(event.target.value)}
          />
          {error !== null && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={target === null || !label.trim() || saving}
              onClick={() => void save()}
            >
              Link
            </Button>
          </div>
        </DialogContentArea>
      </DialogContent>
    </Dialog>
  );
});

function List({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
      {children}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-sm text-foreground-muted">
      {children}
    </div>
  );
}
