import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import type { RoomPermissions } from '@renderer/features/switch-servers/room-permissions';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { AbsoluteTime } from '@renderer/lib/ui/absolute-time';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { Input } from '@renderer/lib/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Textarea } from '@renderer/lib/ui/textarea';
import {
  type RemoteRoomDetail,
  type RemoteRoomRole,
  type RoomAccess,
  roomAccessOf,
  visibilityForAccess,
} from '@shared/core/switch-servers/switch-servers';

/** The query key the room page reads one room under; shared with `room-configuration-panel`. */
function detailKey(workspaceId: string, roomId: string) {
  return ['remote-room-detail', workspaceId, roomId] as const;
}

export const ACCESS_LABELS: Record<RoomAccess, string> = {
  public: 'Everyone in the workspace can see and post',
  read_only: 'Everyone can see it; only the owner and admins post',
  private: 'Only the owner and admins',
};

const ACCESS_ORDER: RoomAccess[] = ['public', 'read_only', 'private'];
const NO_GROUP = '__none__';

/** One write's progress, for a control that saves the moment it changes. */
type WriteState = { phase: 'idle' | 'saving' | 'saved' } | { phase: 'failed'; message: string };

function WriteStatus({ state }: { state: WriteState }) {
  if (state.phase === 'saving')
    return <span className="text-xs text-foreground-muted">Saving…</span>;
  if (state.phase === 'saved') return <span className="text-xs text-foreground-muted">Saved.</span>;
  if (state.phase === 'failed')
    return <span className="text-xs text-destructive">Not saved — {state.message}</span>;
  return null;
}

/**
 * Who may see and post in the room, and the group it is filed under. Each
 * saves as soon as it is picked: a choice from a list is already a decision,
 * unlike half-typed text, so there is nothing to confirm.
 *
 * Access is the owner's and the admins' to change, so for anyone else it is
 * shown as words rather than a control they would only be refused at.
 */
export const AccessAndGroupFields = observer(function AccessAndGroupFields({
  workspaceId,
  room,
  permissions,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
  permissions: RoomPermissions;
}) {
  const queryClient = useQueryClient();
  const [accessState, setAccessState] = useState<WriteState>({ phase: 'idle' });
  const [groupState, setGroupState] = useState<WriteState>({ phase: 'idle' });
  const groups = useQuery({
    queryKey: ['room-groups', workspaceId],
    queryFn: () => rpc.workspaces.listRoomGroups(workspaceId),
    enabled: permissions.canWrite,
  });
  const access = roomAccessOf(room.readVisibility, room.writeVisibility);

  async function write(
    setState: (state: WriteState) => void,
    action: () => Promise<RemoteRoomDetail>,
    fallback: string
  ) {
    setState({ phase: 'saving' });
    try {
      queryClient.setQueryData(detailKey(workspaceId, room.id), await action());
      setState({ phase: 'saved' });
      void refreshSidebarRoomState(true);
    } catch (cause) {
      setState({ phase: 'failed', message: failureText(cause, fallback) });
    }
  }

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-foreground-muted">Who can see and post</span>
        {permissions.canManage ? (
          <Select
            value={access}
            onValueChange={(next) =>
              next !== access &&
              void write(
                setAccessState,
                () =>
                  rpc.workspaces.updateRoom({
                    workspaceId,
                    roomId: room.id,
                    ...visibilityForAccess(next as RoomAccess),
                  }),
                'Could not change who can see this room.'
              )
            }
          >
            <SelectTrigger className="w-full" aria-label="Who can see and post">
              <SelectValue>{ACCESS_LABELS[access]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {ACCESS_ORDER.map((option) => (
                <SelectItem key={option} value={option}>
                  {ACCESS_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-sm text-foreground">{ACCESS_LABELS[access]}</span>
        )}
        <span className="min-h-4 text-xs text-foreground-muted">
          {accessState.phase === 'idle' ? (
            permissions.canManage ? (
              'Only the room’s owner and workspace admins change this.'
            ) : (
              'The room’s owner or a workspace admin can change this.'
            )
          ) : (
            <WriteStatus state={accessState} />
          )}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-foreground-muted">Group</span>
        {permissions.canWrite ? (
          <Select
            value={room.groupId ?? NO_GROUP}
            onValueChange={(next) => {
              const groupId = next === NO_GROUP ? null : (next as string);
              if (groupId === room.groupId) return;
              void write(
                setGroupState,
                () => rpc.workspaces.setRoomGroup({ workspaceId, roomId: room.id, groupId }),
                'Could not change the room’s group.'
              );
            }}
          >
            <SelectTrigger className="w-full" aria-label="Group">
              <SelectValue>{room.groupName ?? 'No group'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_GROUP}>No group</SelectItem>
              {(groups.data ?? []).map((group) => (
                <SelectItem key={group.id} value={group.id}>
                  {group.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-sm text-foreground">{room.groupName ?? 'No group'}</span>
        )}
        <span className="min-h-4 text-xs text-foreground-muted">
          {groupState.phase === 'idle' ? (
            groups.isError ? (
              failureText(groups.error, 'Could not list the groups.')
            ) : (
              'Groups organise rooms and can scope who may talk to an agent.'
            )
          ) : (
            <WriteStatus state={groupState} />
          )}
        </span>
      </div>
    </div>
  );
});

/**
 * The room's roles: hats an agent can put on here, each with the instructions
 * it hands whoever takes it. Addressing `@role` reaches whoever holds it.
 */
export const RolesSection = observer(function RolesSection({
  workspaceId,
  room,
  permissions,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
  permissions: RoomPermissions;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function storeRoles(roles: RemoteRoomRole[]) {
    queryClient.setQueryData<RemoteRoomDetail>(detailKey(workspaceId, room.id), (current) =>
      current ? { ...current, roles } : current
    );
  }

  async function remove(name: string) {
    setError(null);
    try {
      storeRoles(await rpc.workspaces.deleteRoomRole({ workspaceId, roomId: room.id, name }));
    } catch (cause) {
      setError(`Not deleted — ${failureText(cause, 'Could not delete the role.')}`);
    }
  }

  return (
    <section id="room-settings-roles" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">Roles</h2>
          <span className="text-xs text-foreground-muted">{room.roles.length}</span>
        </div>
        {permissions.canWrite && !adding && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            Add role
          </Button>
        )}
      </div>
      <p className="-mt-1 text-xs text-foreground-muted">
        Hats an agent can put on in this room. Mentioning a role reaches whoever holds it.
      </p>

      {adding && (
        <RoleForm
          existing={null}
          takenNames={room.roles.map((role) => role.name)}
          onCancel={() => setAdding(false)}
          onSave={async (input) => {
            storeRoles(
              await rpc.workspaces.createRoomRole({ workspaceId, roomId: room.id, role: input })
            );
            setAdding(false);
          }}
        />
      )}
      {error !== null && <p className="text-xs text-destructive">{error}</p>}

      {room.roles.length === 0 && !adding ? (
        <p className="text-sm text-foreground-muted">No roles in this room.</p>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
          {room.roles.map((role) =>
            editing === role.name ? (
              <div key={role.name} className="p-3">
                <RoleForm
                  existing={role}
                  takenNames={[]}
                  onCancel={() => setEditing(null)}
                  onSave={async (input) => {
                    storeRoles(
                      await rpc.workspaces.updateRoomRole({
                        workspaceId,
                        roomId: room.id,
                        name: role.name,
                        instructions: input.instructions,
                        exclusive: input.exclusive,
                      })
                    );
                    setEditing(null);
                  }}
                />
              </div>
            ) : (
              <div key={role.name} className="flex items-start gap-3 px-3.5 py-2.5">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{role.name}</span>
                    <span className="rounded-full bg-background-tertiary px-2 text-[11px] text-foreground-muted">
                      {role.exclusive ? 'one at a time' : 'shared'}
                    </span>
                  </div>
                  <span className="truncate text-xs text-foreground-muted">
                    {role.heldBy.length > 0
                      ? `Held by ${role.heldBy.join(', ')}`
                      : 'Nobody holds it right now'}
                  </span>
                  {role.instructions && (
                    <span className="line-clamp-2 text-xs text-foreground-muted">
                      {role.instructions}
                    </span>
                  )}
                </div>
                {permissions.canWrite && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Edit ${role.name}`}
                      title="Edit"
                      onClick={() => setEditing(role.name)}
                    >
                      <Pencil />
                    </Button>
                    <ConfirmIconButton
                      label={`Delete ${role.name}`}
                      onConfirm={() => remove(role.name)}
                    />
                  </div>
                )}
              </div>
            )
          )}
        </div>
      )}
    </section>
  );
});

/** A role's fields, for adding one or editing one; the name is fixed once the role exists. */
function RoleForm({
  existing,
  takenNames,
  onCancel,
  onSave,
}: {
  existing: RemoteRoomRole | null;
  takenNames: string[];
  onCancel: () => void;
  onSave: (input: { name: string; instructions: string; exclusive: boolean }) => Promise<void>;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [instructions, setInstructions] = useState(existing?.instructions ?? '');
  const [exclusive, setExclusive] = useState(existing?.exclusive ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const clash = existing === null && takenNames.includes(trimmed);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: trimmed, instructions, exclusive });
    } catch (cause) {
      setError(failureText(cause, 'Could not save the role.'));
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-border p-3">
      {existing === null && (
        <Input
          className="h-9"
          aria-label="Role name"
          autoFocus
          placeholder="Role name, e.g. reviewer"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      )}
      <Textarea
        rows={3}
        aria-label="Role instructions"
        placeholder="What an agent holding this role should do"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
      />
      <label className="flex items-center gap-2 text-sm text-foreground">
        <Checkbox checked={exclusive} onCheckedChange={(next) => setExclusive(next === true)} />
        Only one agent can hold it at a time
      </label>
      {existing !== null && (
        <p className="text-xs text-foreground-muted">
          An agent already holding this role keeps the instructions it was given until it takes the
          role again.
        </p>
      )}
      {clash && (
        <p className="text-xs text-destructive">This room already has a role called that.</p>
      )}
      {error !== null && <p className="text-xs text-destructive">Not saved — {error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" disabled={saving || trimmed === '' || clash} onClick={() => void save()}>
          {saving ? 'Saving…' : existing === null ? 'Add role' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

/** A delete that asks once more before it acts: the first click arms it, the second deletes. */
function ConfirmIconButton({
  label,
  onConfirm,
}: {
  label: string;
  onConfirm: () => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  if (armed) {
    return (
      <Button
        variant="outline"
        size="xs"
        className="border-red-500/40 text-red-500 hover:bg-red-500/10 hover:text-red-500"
        disabled={busy}
        onBlur={() => !busy && setArmed(false)}
        onClick={async () => {
          setBusy(true);
          await onConfirm();
          setBusy(false);
          setArmed(false);
        }}
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : 'Delete'}
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title="Delete"
      onClick={() => setArmed(true)}
    >
      <Trash2 />
    </Button>
  );
}

/** Facts about the room that nobody edits here, for finding it elsewhere. */
export function RoomInfoSection({ room }: { room: RemoteRoomDetail }) {
  const rows: [string, React.ReactNode][] = [
    [
      'Created',
      room.createdAt ? <AbsoluteTime key="created" value={room.createdAt} includeYear /> : '—',
    ],
    ['Owner', room.ownerName ?? '—'],
    [
      'Messaging app',
      room.bridgeDisplayName ?? (room.isConsoleChat ? 'Group chat in Switch Console' : 'None'),
    ],
  ];
  if (room.linkedChannelName) rows.push(['Channel', `#${room.linkedChannelName}`]);
  if (room.externalChannelId)
    rows.push(['Channel id', <Mono key="c">{room.externalChannelId}</Mono>]);
  if (room.transportRoomId)
    rows.push(['Switch room id', <Mono key="t">{room.transportRoomId}</Mono>]);
  return (
    <section id="room-settings-info" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-foreground">Room info</h2>
      <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-foreground-muted">{label}</dt>
            <dd className="min-w-0 truncate text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-xs select-all">{children}</span>;
}

/**
 * Archiving the room, beside deleting it. Archiving keeps everything and is
 * undone here; while archived, the room drops out of the room lists and its
 * page says so.
 */
export const ArchiveRoomSection = observer(function ArchiveRoomSection({
  workspaceId,
  room,
  permissions,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
  permissions: RoomPermissions;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!permissions.canWrite) return null;

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const updated = await rpc.workspaces.setRoomArchived({
        workspaceId,
        roomId: room.id,
        archived: !room.archived,
      });
      queryClient.setQueryData(detailKey(workspaceId, room.id), updated);
      await switchRoomsStore.refreshRoomState();
      void refreshSidebarRoomState(true);
      void queryClient.invalidateQueries({ queryKey: ['archived-rooms', workspaceId] });
    } catch (cause) {
      setError(
        failureText(
          cause,
          room.archived ? 'Could not unarchive the room.' : 'Could not archive the room.'
        )
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium text-foreground">
          {room.archived ? 'Unarchive room' : 'Archive room'}
        </h3>
        <p className="text-xs text-foreground-muted">
          {room.archived
            ? 'Puts the room back in the room lists, with everything in it.'
            : 'Takes the room out of the room lists and stops agents joining it. Nothing in it is deleted, and you can unarchive it from Your Rooms.'}
        </p>
        {error !== null && <p className="text-xs text-destructive">{error}</p>}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={busy}
        onClick={() => void toggle()}
      >
        {room.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
        {busy
          ? room.archived
            ? 'Unarchiving…'
            : 'Archiving…'
          : room.archived
            ? 'Unarchive'
            : 'Archive'}
      </Button>
    </div>
  );
});
