import {
  type RosterAgent,
  type RosterPerson,
  RoomRoster,
} from '@switch-console/chat-ui/components/room-roster';
import { chatAgentLabel } from '@switch-console/chat-ui/contracts/chats';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { chatFailure } from '@renderer/features/chats/chat-errors';
import { chatMembersQueryKey } from '@renderer/features/chats/chat-people';
import { opensAsConsoleChat } from '@renderer/features/chats/console-chat-redirect';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { isConsoleGroupChatSummary } from '@renderer/features/switch-servers/room-filters';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import {
  Dialog,
  DialogContent,
  DialogContentArea,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import type { RemoteRoomDetail } from '@shared/core/switch-servers/switch-servers';
import {
  AddAgentPanel,
  AddPeoplePanel,
  AddRoomAdminPanel,
  ChatAddParticipantPanel,
} from './room-add-participants';
import { roomAdminAction, roomAdminStandingOf } from './room-admins';
import { linkedNamesByUsername } from './room-labels';
import { roomInviteability } from './room-membership';
import { AgentMark, agentNameFor, roomDetailKey, useRoomDetail } from './room-participants';

/** What the viewer may change about who is in the room, and how. */
type RosterControls = {
  /** Opens adding agents, or null for someone who may not add them. */
  addAgents: (() => void) | null;
  /** Opens adding people, or null where they cannot be added. */
  addPeople: (() => void) | null;
  /** Why people cannot be added here, for someone who could otherwise. */
  peopleNote: string | null;
  /** Null for someone who may not remove this agent. */
  removeAgent: (agentId: string) => (() => Promise<void>) | null;
  /** Null for someone who may not remove people, or for a person who cannot be removed. */
  removePerson: (key: string) => (() => Promise<void>) | null;
  /** Making someone a room admin or taking them off; null where the room has none. */
  setRoomAdmin: ((userId: string, admin: boolean) => Promise<void>) | null;
  /** Whether the agent is told when someone joins, and the way to change it; null where it cannot be. */
  joinEvents: {
    listening: (agentId: string) => boolean;
    /** Whether this viewer may change it for this agent. */
    canSet: (agentId: string) => boolean;
    set: (agentId: string, on: boolean) => Promise<void>;
  } | null;
};

const NO_CONTROLS: RosterControls = {
  addAgents: null,
  addPeople: null,
  peopleNote: null,
  removeAgent: () => null,
  removePerson: () => null,
  setRoomAdmin: null,
  joinEvents: null,
};

/**
 * Who is in the room, beside it on every tab and on every platform: the
 * agents and what each is doing here, and the people. Whoever may change the
 * room adds and removes them here too. The room's settings and resources are
 * its tabs, so nothing else lives in this column.
 */
export const RoomSidePanel = observer(function RoomSidePanel({ roomId }: { roomId: string }) {
  const queryClient = useQueryClient();
  const chat = chatsStore.chat(roomId);
  const consoleChat = opensAsConsoleChat(roomId);
  const workspaceId =
    switchRoomsStore.roomWorkspaceId(roomId) ?? (chat ? workspacesStore.activeId : null);
  const serverId =
    switchRoomsStore.roomServerId(roomId) ?? (chat ? chatsStore.serverId : null) ?? null;
  const groupChats = useFeatureFlags(serverId).group_chats;
  const showAddAgentsToRoomModal = useShowModal('addAgentsToRoomModal');
  const { navigate } = useNavigate();
  const managed = useManagedAgents(serverId);
  const [adding, setAdding] = useState<'agents' | 'people' | 'admins' | null>(null);
  // Anyone taking part may read the room, so this answers for a chat's members too.
  const detail = useRoomDetail(workspaceId, roomId, true);
  // Whose each agent is, so the viewer is offered taking out their own.
  const workspaceAgents = useWorkspaceAgents(workspaceId);
  const membersKey = chat && serverId ? chatMembersQueryKey(serverId, chat) : ['no-chat-members'];
  const members = useQuery({
    queryKey: membersKey,
    queryFn: () => rpc.chats.members(serverId as string, roomId),
    enabled: consoleChat && chat !== null && serverId !== null,
  });

  const room = detail.data ?? null;
  const bridgeId = consoleChat ? null : (room?.bridgeId ?? null);
  // Who linked each username, to name them beside it. Shares the Add people
  // panel's cache. Only a label, so it is kept a while rather than fetched on
  // every open, and a failure is not retried: the usernames are shown alone, with a
  // note saying why.
  const bridgePeople = useQuery({
    queryKey: ['bridge-people', workspaceId, bridgeId],
    queryFn: () =>
      rpc.workspaces.listBridgePeople({
        workspaceId: workspaceId as string,
        bridgeId: bridgeId as string,
      }),
    enabled: workspaceId !== null && bridgeId !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const linkedNames = linkedNamesByUsername(bridgePeople.data ?? []);
  const linkedIds = new Map(
    (bridgePeople.data ?? []).map((person) => [person.username, person.linkedUserIds])
  );
  const viewerId = serverId ? (switchServersStore.statusFor(serverId)?.user?.id ?? null) : null;
  // A room that could not be read is not an empty one: say so, rather than "no agents yet".
  const unreadable = !consoleChat && detail.isError;
  const agentIds = chat ? chat.agents.map((agent) => agent.id) : (room?.agentIds ?? []);
  const chatNames = new Map((chat?.agents ?? []).map((agent) => [agent.id, chatAgentLabel(agent)]));
  const people = consoleChat
    ? (members.data ?? []).map((member) => ({
        key: member.userId,
        name: member.name,
        fullName: null,
        detail: member.isOwner ? 'owner' : null,
        isOwner: member.isOwner,
        userIds: [member.userId],
      }))
    : (room?.connectedUserNames ?? []).map((name) => ({
        key: name,
        name,
        fullName: linkedNames.get(name) ?? null,
        detail: null,
        isOwner: false,
        userIds: linkedIds.get(name) ?? [],
      }));

  async function refreshRoom() {
    await queryClient.invalidateQueries({ queryKey: roomDetailKey(workspaceId ?? '', roomId) });
    await switchRoomsStore.refreshRoomState();
  }

  const adminViewer = {
    userId: viewerId,
    canManageAdmins:
      room !== null && workspaceId !== null
        ? switchRoomsStore.roomPermissions(workspaceId, room).canManageAdmins
        : false,
  };

  let controls = NO_CONTROLS;
  if (consoleChat && chat && serverId && isConsoleGroupChatSummary(chat) && chat.canManage) {
    controls = {
      ...NO_CONTROLS,
      // Adding to a chat makes it a group, which the server offers only with group chats on.
      addAgents: groupChats ? () => setAdding('agents') : null,
      removeAgent: (agentId) => async () => {
        await rpc.chats.removeAgent({ serverId, roomId, agentId });
        chatsStore.dropAgent(roomId, agentId);
      },
      // The owner stays: there is no one to hand the chat to.
      removePerson: (key) =>
        people.find((person) => person.key === key)?.isOwner
          ? null
          : async () => {
              await rpc.chats.removeMember({ serverId, roomId, userId: key });
              await queryClient.invalidateQueries({ queryKey: membersKey });
            },
    };
  } else if (!consoleChat && room && workspaceId) {
    const permissions = switchRoomsStore.roomPermissions(workspaceId, room);
    const inviteability = roomInviteability(room, bridgePlatformLabel(room.bridgeType));
    // Adding to a room takes being in it, and taking agents out its owner or
    // an admin; a direct or group conversation's platform fixes who is in it,
    // so the server sets neither there. Its settings take `canWrite`.
    const addAgents = permissions.canInviteAgents ? () => setAdding('agents') : null;
    const addPeople =
      permissions.canAddPeople && inviteability.canInvite ? () => setAdding('people') : null;
    // Anyone may take out their own agent, outside a direct or group
    // conversation, whose platform fixes who is in it.
    const fixedMembers = room.channelType === 'direct' || room.channelType === 'group';
    const ownerOf = new Map((workspaceAgents.data ?? []).map((agent) => [agent.id, agent.ownerId]));
    const removeAgent = (agentId: string) =>
      permissions.canRemoveMembers ||
      (!fixedMembers && viewerId !== null && ownerOf.get(agentId) === viewerId)
        ? async () => {
            await rpc.workspaces.removeRoomAgent({ workspaceId, roomId, agentId });
            await refreshRoom();
          }
        : null;
    const peopleNote =
      permissions.canAddPeople && !inviteability.canInvite ? inviteability.reason : null;
    // The server says who may do what (`canManageAdmins`, or stepping down);
    // the answer is the room as it now stands.
    const setRoomAdmin = async (userId: string, admin: boolean) => {
      queryClient.setQueryData(
        roomDetailKey(workspaceId, roomId),
        await rpc.workspaces.setRoomAdmin({ workspaceId, roomId, userId, admin })
      );
      // Stepping down changes what the viewer may do with the room.
      if (userId === viewerId) await switchRoomsStore.refreshRoomState();
    };
    // The room's owner or an admin, or the agent's own owner, may change
    // whether it hears joins.
    const joinEvents: RosterControls['joinEvents'] = {
      listening: (agentId) => room.joinEventListeners.includes(agentId),
      canSet: (agentId) =>
        permissions.canWrite || (viewerId !== null && ownerOf.get(agentId) === viewerId),
      set: async (agentId, on) => {
        queryClient.setQueryData(
          roomDetailKey(workspaceId, roomId),
          await rpc.workspaces.setRoomAgentJoinEvents({
            workspaceId,
            roomId,
            agentId,
            receivesJoinEvents: on,
          })
        );
      },
    };
    if (!permissions.canWrite) {
      controls = {
        ...NO_CONTROLS,
        addAgents,
        addPeople,
        peopleNote,
        removeAgent,
        setRoomAdmin,
        joinEvents,
      };
    } else {
      controls = {
        addAgents,
        addPeople,
        peopleNote,
        removeAgent,
        // Switch only knows the people it saw or added; it cannot take them out of a channel.
        removePerson: () => null,
        setRoomAdmin,
        joinEvents,
      };
    }
  }

  const remoteById = new Map((workspaceAgents.data ?? []).map((agent) => [agent.id, agent]));
  const agentRows: RosterAgent[] = agentIds.map((agentId) => {
    const own = (managed.data ?? []).find((agent) => agent.agentId === agentId) ?? null;
    const joinEvents = controls.joinEvents?.canSet(agentId) ? controls.joinEvents : null;
    return {
      id: agentId,
      label: chatNames.get(agentId) ?? agentNameFor(agentId, workspaceId, remoteById),
      mark: <AgentMark agentId={agentId} workspaceId={workspaceId} remoteById={remoteById} />,
      status: room?.agentStatuses[agentId],
      roles: rolesHeldBy(room?.roles ?? [], remoteById.get(agentId)?.name ?? null),
      open:
        own && serverId
          ? () => navigate('managedAgent', { serverId, agentId, name: own.name, room: roomId })
          : null,
      joinEvents: joinEvents && {
        listening: joinEvents.listening(agentId),
        set: (on) => joinEvents.set(agentId, on),
      },
      remove: controls.removeAgent(agentId),
    };
  });
  const personRows: RosterPerson[] = unreadable
    ? []
    : people.map((person) => {
        const standing = room && controls.setRoomAdmin ? roomAdminStandingOf(room, person) : null;
        const adminAction = standing && roomAdminAction(standing, adminViewer);
        const setRoomAdmin = controls.setRoomAdmin;
        const remove = controls.removePerson(person.key);
        return {
          key: person.key,
          name: person.name,
          userId: person.userIds[0] ?? null,
          fullName: person.fullName,
          detail: standing?.isAdmin ? 'room admin' : person.detail,
          actions: [
            ...(standing && adminAction && setRoomAdmin
              ? [
                  {
                    label: adminAction.label,
                    run: () => setRoomAdmin(standing.userId, adminAction.admin),
                    failure: adminAction.failure,
                  },
                ]
              : []),
            ...(remove
              ? [
                  {
                    label: 'Remove from room',
                    run: remove,
                    failure: `Could not remove ${person.name}.`,
                    destructive: true,
                  },
                ]
              : []),
          ],
        };
      });
  const showAdmins =
    room !== null &&
    controls.setRoomAdmin !== null &&
    (room.roomAdmins.length > 0 || adminViewer.canManageAdmins);
  const adminRows: RosterPerson[] =
    room && showAdmins
      ? room.roomAdmins.map((admin) => {
          const name = admin.name ?? 'Someone';
          const action = roomAdminAction(
            { userId: admin.userId, name, isAdmin: true },
            adminViewer
          );
          const setRoomAdmin = controls.setRoomAdmin;
          return {
            key: admin.userId,
            name,
            userId: admin.userId,
            fullName: null,
            detail: admin.userId === viewerId ? 'you' : null,
            actions:
              action && setRoomAdmin
                ? [
                    {
                      label: action.label,
                      run: () => setRoomAdmin(admin.userId, false),
                      failure: action.failure,
                    },
                  ]
                : [],
          };
        })
      : [];

  return (
    <RoomRoster
      addParticipants={consoleChat ? controls.addAgents : null}
      agents={{
        title: 'Agents',
        count: agentIds.length,
        onAdd: consoleChat ? null : controls.addAgents,
        addLabel: 'Add agents',
        rows: unreadable ? [] : agentRows,
        empty: unreadable
          ? failureText(detail.error, 'Could not read who is in this room.')
          : agentIds.length === 0
            ? 'No agents in this room yet.'
            : null,
        notes: [],
      }}
      people={{
        title: consoleChat ? 'People' : 'People seen here',
        count: people.length,
        onAdd: controls.addPeople,
        addLabel: 'Add people',
        rows: personRows,
        empty:
          unreadable || people.length > 0
            ? null
            : consoleChat
              ? 'Nobody else is here yet.'
              : 'Nobody has been seen here yet.',
        notes: [
          // Switch only knows the people who posted here or were added through it.
          ...(consoleChat
            ? []
            : ['People who posted here or were added through Switch. The channel may have more.']),
          // Said, so a lookup that failed does not pass for people nobody linked.
          ...(bridgePeople.isError && people.length > 0
            ? ['Could not load people’s names, so only their usernames are shown.']
            : []),
          ...(controls.peopleNote !== null ? [controls.peopleNote] : []),
        ],
      }}
      admins={
        room && showAdmins
          ? {
              title: 'Room admins',
              count: room.roomAdmins.length,
              onAdd:
                adminViewer.canManageAdmins && room.roomAdminCandidates.length > 0
                  ? () => setAdding('admins')
                  : null,
              addLabel: 'Add room admin',
              rows: adminRows,
              empty: room.roomAdmins.length === 0 ? 'No room admins yet.' : null,
              notes: adminViewer.canManageAdmins
                ? [
                    'Room admins change the room as its owner does, but cannot delete it, change who can see it or choose room admins.',
                  ]
                : [],
            }
          : null
      }
      describe={(cause, fallback) =>
        consoleChat ? chatFailure(cause).message : failureText(cause, fallback)
      }
      dialog={
        <Dialog open={adding !== null} onOpenChange={(open) => !open && setAdding(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {adding === 'admins'
                  ? 'Add room admin'
                  : adding === 'people'
                    ? 'Add people'
                    : consoleChat
                      ? 'Add participants'
                      : 'Add agents'}
              </DialogTitle>
            </DialogHeader>
            <DialogContentArea className="flex flex-col gap-3 pt-0">
              {adding === 'agents' && consoleChat && chat && serverId && (
                <ChatAddParticipantPanel
                  serverId={serverId}
                  workspaceId={workspaceId}
                  chat={chat}
                  memberIds={new Set(people.map((person) => person.key))}
                  onAddedPeople={(next) => queryClient.setQueryData(membersKey, next)}
                />
              )}
              {adding === 'agents' && !consoleChat && room && workspaceId && (
                <>
                  <AddAgentPanel workspaceId={workspaceId} room={room} onAdded={refreshRoom} />
                  <Button
                    variant="outline"
                    size="sm"
                    className="self-start"
                    onClick={() => {
                      setAdding(null);
                      showAddAgentsToRoomModal({ roomId });
                    }}
                  >
                    <FileText className="size-3.5" />
                    From a template
                  </Button>
                </>
              )}
              {adding === 'admins' && room && workspaceId && (
                <AddRoomAdminPanel workspaceId={workspaceId} room={room} />
              )}
              {adding === 'people' && room && workspaceId && room.bridgeId !== null && (
                <AddPeoplePanel workspaceId={workspaceId} room={room} bridgeId={room.bridgeId} />
              )}
            </DialogContentArea>
          </DialogContent>
        </Dialog>
      }
    />
  );
});

/**
 * The roles an agent holds. The server names a role's holders by the agent's
 * server-side name, so that is what is matched, never the name this install
 * shows (a local rename, or a chat's label); null holds nothing.
 */
export function rolesHeldBy(roles: RemoteRoomDetail['roles'], serverName: string | null): string[] {
  if (serverName === null) return [];
  return roles.filter((role) => role.heldBy.includes(serverName)).map((role) => role.name);
}
