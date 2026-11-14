import { type ChatSummary } from '@switch-console/chat-ui/contracts/chats';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, FileText, Loader2, Lock, RefreshCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { confirmLeaveChat } from '@renderer/features/chats/components/chat-actions';
import { opensAsConsoleChat } from '@renderer/features/chats/console-chat-redirect';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { isConsoleGroupChatSummary } from '@renderer/features/switch-servers/room-filters';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { administersWorkspaceById } from '@renderer/features/switch-servers/workspace-admin';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { describeFailure, failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { Textarea } from '@renderer/lib/ui/textarea';
import { cn } from '@renderer/utils/utils';
import type { RemoteRoomDetail } from '@shared/core/switch-servers/switch-servers';
import { RoomAutoRouteSection } from './room-auto-route-section';
import { channelOnDeleteSummary } from './room-delete-wording';
import { roomTitle } from './room-labels';
import { agentNameFor, roomDetailKey, useRoomDetail } from './room-participants';
import { SchedulesSection } from './room-schedules-section';
import {
  AccessAndGroupFields,
  ArchiveRoomSection,
  RolesSection,
  RoomInfoSection,
} from './room-settings-sections';

/** One room read from its server; `workspaceId` is null until the room list has loaded. */
function useRoomInWorkspace(roomId: string) {
  const workspaceId = switchRoomsStore.roomWorkspaceId(roomId);
  const query = useRoomDetail(workspaceId, roomId, !opensAsConsoleChat(roomId));
  return { workspaceId, query };
}

/**
 * A group chat's settings, read from the chat rather than the room list, which
 * an invited person is not on. Description and instructions are the room's,
 * shown only to someone who may manage the chat and so may read and write them.
 */
const ChatConfiguration = observer(function ChatConfiguration({
  serverId,
  chat,
}: {
  serverId: string;
  chat: ChatSummary;
}) {
  const workspaceId = switchRoomsStore.roomWorkspaceId(chat.roomId) ?? workspacesStore.activeId;
  const detail = useRoomDetail(workspaceId, chat.roomId, chat.canManage);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-8 px-10 py-8">
        {workspaceId !== null && detail.data && (
          <GeneralSection
            key={chat.roomId}
            workspaceId={workspaceId}
            room={detail.data}
            readOnly={false}
          />
        )}
        {detail.isError && (
          <p className="text-xs text-foreground-muted">
            {failureText(detail.error, 'Could not read this chat’s description and instructions.')}
          </p>
        )}
        {workspaceId !== null && detail.data && (
          <>
            <RolesSection
              workspaceId={workspaceId}
              room={detail.data}
              permissions={{
                canWrite: chat.canManage,
                canChangeMembers: chat.canManage,
                canInviteAgents: chat.canManage,
                canAddPeople: chat.canManage,
                canAttach: chat.canManage,
                canRemoveMembers: chat.canManage,
                canManage: chat.canManage,
                canArchive: chat.canManage,
                canManageAdmins: false,
                canUnlink: chat.canManage,
              }}
            />
            <RoomInfoSection room={detail.data} />
          </>
        )}
        <section className="border-t border-border pt-6">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <h3 className="text-sm font-medium text-foreground">Leave room</h3>
              <p className="text-xs text-foreground-muted">
                You stop seeing its messages; someone who manages it can add you back.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => confirmLeaveChat(serverId, chat)}
            >
              Leave room…
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
});

/**
 * A room's settings: what it is for, what it tells agents on arrival, and who is
 * in it.
 *
 * Read one room at a time rather than from the room list, which carries neither
 * the instructions nor the membership — and written straight back from the
 * server's reply, so the page always shows what was actually stored.
 */
export const RoomConfigurationPanel = observer(function RoomConfigurationPanel({
  roomId,
}: {
  roomId: string;
}) {
  const { workspaceId, query } = useRoomInWorkspace(roomId);
  const chat = chatsStore.chat(roomId);

  if (chat && chatsStore.serverId && isConsoleGroupChatSummary(chat)) {
    return <ChatConfiguration serverId={chatsStore.serverId} chat={chat} />;
  }
  if (opensAsConsoleChat(roomId)) {
    return <PanelNotice title="You no longer have access to this chat." />;
  }

  if (workspaceId === null) {
    return <PanelNotice title="This room’s workspace is still loading." />;
  }

  if (query.isPending) {
    return (
      <PanelNotice
        icon={<Loader2 className="size-5 animate-spin" />}
        title="Loading this room’s settings…"
      />
    );
  }

  if (query.isError) {
    const settingsReadFailure = describeFailure(
      query.error,
      'Could not read this room’s settings.'
    );
    return (
      <PanelNotice
        title={settingsReadFailure.headline}
        detail={settingsReadFailure.detail ?? undefined}
        action={
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            <RefreshCw className="size-3" />
            Retry
          </Button>
        }
      />
    );
  }

  const room = query.data;
  const permissions = switchRoomsStore.roomPermissions(workspaceId, room);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[880px] gap-10 px-10 py-8">
        <div className="flex min-w-0 flex-1 flex-col gap-8">
          <RoomHeading serverId={switchRoomsStore.roomServerId(roomId)} room={room} />
          {room.archived && (
            <Notice icon={<Archive className="size-3.5" />}>
              This room is archived, so it is hidden from room lists. Everything in it is kept.
            </Notice>
          )}
          {!permissions.canWrite && (
            <Notice icon={<Lock className="size-3.5" />}>
              Only {room.ownerName ?? 'the room’s owner'}, a room admin or a workspace admin can
              change this room’s settings.
            </Notice>
          )}
          {/* Keyed on the room so the drafts below belong to the room on screen:
              switching rooms starts a fresh form rather than carrying half-typed
              text across. */}
          <GeneralSection
            key={room.id}
            workspaceId={workspaceId}
            room={room}
            readOnly={!permissions.canWrite}
          />
          <AccessAndGroupFields
            workspaceId={workspaceId}
            room={room}
            permissions={permissions}
            administersWorkspace={administersWorkspaceById(workspaceId)}
          />
          {/* Absent from a server that predates decision routing. */}
          {room.autoRoute && (
            <AutoRouteSection
              workspaceId={workspaceId}
              room={room}
              autoRoute={room.autoRoute}
              canWrite={permissions.canWrite}
              // Its owner's or an admin's on a server that predates room admins.
              canChooseTriage={permissions.canManage || room.viewerIsRoomAdmin}
            />
          )}
          <RolesSection workspaceId={workspaceId} room={room} permissions={permissions} />
          <SchedulesSection workspaceId={workspaceId} room={room} permissions={permissions} />
          <RoomInfoSection room={room} />
          <section
            id="room-settings-archive"
            className="flex flex-col gap-5 border-t border-border pt-6"
          >
            <ArchiveRoomSection workspaceId={workspaceId} room={room} permissions={permissions} />
            <DeleteRoomSection workspaceId={workspaceId} room={room} />
          </section>
        </div>
      </div>
    </div>
  );
});

function Notice({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-background-secondary px-3 py-2 text-xs text-foreground-muted">
      {icon}
      <span>{children}</span>
    </div>
  );
}

/**
 * Deleting the room, last on its page and below a rule.
 *
 * Absent entirely for anyone who may not delete it, rather than shown disabled:
 * a greyed control invites you to go and find the permission, and here there is
 * none to find — the room is someone else's.
 */
const DeleteRoomSection = observer(function DeleteRoomSection({
  workspaceId,
  room,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
}) {
  const showDeleteRoomModal = useShowModal('deleteRoomModal');
  const { navigate } = useNavigate();

  if (!switchRoomsStore.canDeleteRoom(workspaceId, room)) return null;

  return (
    <section className="border-t border-border pt-6">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium text-foreground">Delete room</h3>
          <p className="text-xs text-foreground-muted">
            Removes the room and its conversation for everyone in it.
            {room.bridgeType
              ? ` ${channelOnDeleteSummary(bridgePlatformLabel(room.bridgeType), room.channelOnDelete) ?? ''}`
              : ''}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 border-red-500/40 text-red-500 hover:bg-red-500/10 hover:text-red-500"
          onClick={() =>
            showDeleteRoomModal({
              workspaceId,
              roomId: room.id,
              roomName: roomTitle(room),
              // The page this is on is the deleted room's own, so staying would
              // leave a settings form for something that no longer exists.
              onSuccess: () => navigate('home'),
            })
          }
        >
          Delete room…
        </Button>
      </div>
    </section>
  );
});

/**
 * What the settings page itself offers about the room. Its name, where it
 * lives and the way to its channel are in the title bar above.
 */
function RoomHeading({ serverId, room }: { serverId: string | null; room: RemoteRoomDetail }) {
  const { navigate } = useNavigate();
  if (serverId === null) return null;
  return (
    <div className="flex justify-end">
      <Button
        variant="outline"
        size="sm"
        onClick={() => navigate('templateCapture', { serverId, roomId: room.id })}
      >
        <FileText className="size-3.5" />
        Capture as template
      </Button>
    </div>
  );
}

/** What the section is doing, once the user has stopped typing in it. */
type SaveState = { phase: 'idle' | 'saving' | 'saved' } | { phase: 'failed'; message: string };

/**
 * Description and instructions, written when Save is pressed.
 *
 * They used to commit when a field lost focus, which meant the moment they were
 * stored was the moment you looked away — and leaving the tab was the only
 * thing that reliably did it. Editing and storing are now separate acts, and
 * the button says which state the section is in: changed and unsaved, writing,
 * written, or refused in the server's own words.
 *
 * One request carries both fields, so the pair is stored together or not at all.
 */
function GeneralSection({
  workspaceId,
  room,
  readOnly,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
  /** For someone who may read the room but not change it: the fields show, and do not take edits. */
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const savedName = room.name;
  const savedDescription = room.description;
  const savedInstructions = room.instructions ?? '';
  const [name, setName] = useState(savedName);
  const [description, setDescription] = useState(savedDescription);
  const [instructions, setInstructions] = useState(savedInstructions);
  const [state, setState] = useState<SaveState>({ phase: 'idle' });

  const renamed = name.trim() !== savedName;
  const dirty = renamed || description !== savedDescription || instructions !== savedInstructions;

  async function save() {
    setState({ phase: 'saving' });
    try {
      const updated = await rpc.workspaces.updateRoom({
        workspaceId,
        roomId: room.id,
        ...(renamed ? { name: name.trim() } : {}),
        description,
        instructions,
      });
      queryClient.setQueryData(roomDetailKey(workspaceId, room.id), updated);
      setName(updated.name);
      setState({ phase: 'saved' });
      // The name shows in the sidebar, the room lists and the chat's title.
      if (renamed) {
        void refreshSidebarRoomState(true);
        void chatsStore.refreshSummaries();
      }
    } catch (cause) {
      setState({ phase: 'failed', message: failureText(cause, 'Could not save the change.') });
    }
  }

  return (
    <section id="room-settings-general" className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold text-foreground">General</h2>

      <Field label="Name" hint="What everyone in the room sees it called.">
        <Input
          className="h-9"
          aria-label="Name"
          disabled={readOnly}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setState({ phase: 'idle' });
          }}
        />
      </Field>
      <LinkedChannelName
        workspaceId={workspaceId}
        room={room}
        onSynced={(updated) => setName(updated.name)}
      />

      <Field
        label="Description"
        hint="Helps other people and agents understand what this room is for."
      >
        <Input
          className="h-9"
          placeholder="What this room is for"
          disabled={readOnly}
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            setState({ phase: 'idle' });
          }}
        />
      </Field>

      <Field label="Instructions" hint="Sent to every agent as it joins the room.">
        <Textarea
          rows={4}
          placeholder="Optional guidance shown to agents when they enter the room"
          disabled={readOnly}
          value={instructions}
          onChange={(e) => {
            setInstructions(e.target.value);
            setState({ phase: 'idle' });
          }}
        />
      </Field>

      {/* The status sits beside the button rather than under a field: one
          request covers both, so there is one answer to report. */}
      <div className={cn('flex items-center justify-end gap-3', readOnly && 'hidden')}>
        <SaveStatus state={state} dirty={dirty} />
        <Button
          type="button"
          size="sm"
          disabled={!dirty || name.trim() === '' || state.phase === 'saving'}
          onClick={() => void save()}
        >
          {state.phase === 'saving' ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </section>
  );
}

/**
 * The channel a bridged room is linked to, when it is called something else
 * there, with a way for someone who manages the room to name it after the
 * channel, which it then follows when the channel is renamed.
 */
const LinkedChannelName = observer(function LinkedChannelName({
  workspaceId,
  room,
  onSynced,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
  onSynced: (updated: RemoteRoomDetail) => void;
}) {
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const channel = room.linkedChannelName;
  if (!channel || channel === room.name || `#${channel}` === room.name) return null;
  const canSync = switchRoomsStore.canDeleteRoom(workspaceId, room);

  async function sync() {
    setSyncing(true);
    setError(null);
    try {
      const updated = await rpc.workspaces.syncRoomName({ workspaceId, roomId: room.id });
      queryClient.setQueryData(roomDetailKey(workspaceId, room.id), updated);
      onSynced(updated);
      void refreshSidebarRoomState(true);
      void chatsStore.refreshSummaries();
    } catch (cause) {
      setError(failureText(cause, 'Could not name the room after its channel.'));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="-mt-2 flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
      <span>Linked channel: #{channel}</span>
      {canSync && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={syncing}
          onClick={() => void sync()}
        >
          {syncing ? 'Renaming…' : 'Use channel name'}
        </Button>
      )}
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </div>
  );
});

/** Says where the edits stand, so an unsaved change is never silent. */
function SaveStatus({ state, dirty }: { state: SaveState; dirty: boolean }) {
  if (state.phase === 'failed') {
    return <span className="text-xs text-destructive">Not saved — {state.message}</span>;
  }
  if (state.phase === 'saved' && !dirty) {
    return <span className="text-xs text-foreground-muted">Saved.</span>;
  }
  if (dirty) {
    return <span className="text-xs text-foreground-muted">Unsaved changes.</span>;
  }
  return null;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm text-foreground-muted">{label}</span>
      {children}
      <span className="text-xs text-foreground-muted">{hint}</span>
    </div>
  );
}

/** The room's auto-route switch and triage agent, offering the room's own agents. */
const AutoRouteSection = observer(function AutoRouteSection({
  workspaceId,
  room,
  autoRoute,
  canWrite,
  canChooseTriage,
}: {
  workspaceId: string;
  room: RemoteRoomDetail;
  autoRoute: NonNullable<RemoteRoomDetail['autoRoute']>;
  canWrite: boolean;
  canChooseTriage: boolean;
}) {
  const remoteAgents = useWorkspaceAgents(workspaceId);
  const remoteById = new Map((remoteAgents.data ?? []).map((a) => [a.id, a]));
  const agents = room.agentIds.map((id) => ({
    id,
    name: agentNameFor(id, workspaceId, remoteById),
  }));
  return (
    <RoomAutoRouteSection
      workspaceId={workspaceId}
      room={room}
      autoRoute={autoRoute}
      agents={agents}
      canWrite={canWrite}
      canChooseTriage={canChooseTriage}
      detailKey={roomDetailKey(workspaceId, room.id)}
    />
  );
});

function PanelNotice({
  icon,
  title,
  detail,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      {icon && <div className="text-foreground-passive">{icon}</div>}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {detail && <p className="max-w-md text-xs text-foreground-muted">{detail}</p>}
      {action}
    </div>
  );
}
