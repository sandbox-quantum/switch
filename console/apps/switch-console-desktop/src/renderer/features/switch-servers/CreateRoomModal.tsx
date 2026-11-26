import {
  type CreateRoomAgents,
  CreateRoomDialog,
  type CreateRoomHost,
} from '@switch-console/chat-ui/components/create-room-dialog';
import { agentParticipant } from '@switch-console/chat-ui/model/participant-search';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { openRoomView } from '@renderer/features/sidebar/sidebar-room-grouping';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { addableAgents, addablePeople } from '@renderer/features/switch-rooms/room-labels';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { agentProviderLabel } from '@renderer/lib/components/agent-mark';
import { agentProviderLabelFor } from '@renderer/lib/components/agent-picker';
import { CONSOLE_PARTICIPANT_MARKS } from '@renderer/lib/components/participant-picker';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps, useModalContext } from '@renderer/lib/modal/modal-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import {
  invitableAgents,
  useRoomAgentCandidates,
} from '@renderer/lib/stores/use-room-agent-candidates';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import { knownAgentTypeDisplayName } from '@shared/core/providers/agent-provider-registry';
import { accountName } from './link-accounts-prose';
import { MessagingAppSelector } from './messaging-app-selector';
import { switchServersStore } from './switch-servers-store';
import { useMyIdentities } from './use-my-identities';
import { administersWorkspaceById } from './workspace-admin';

type CreateRoomModalArgs = {
  /** Create on this server instead of the active one — for callers that are not
   * driven by the sidebar's server scope, such as onboarding. */
  serverId?: string;
  /** An agent to start the room with, already picked: the room is made from its page. */
  agentId?: string;
};

type Props = BaseModalProps<{ roomId: string }> & CreateRoomModalArgs;

/** The shared New room dialog, reading and making rooms through Switch Console's stores and IPC. */
export const CreateRoomModal = observer(function CreateRoomModal({
  serverId: overrideServerId,
  agentId: startingAgentId,
  onSuccess,
  onClose,
}: Props) {
  const { setCloseGuard } = useModalContext();

  // The sidebar shows one server at a time, so the room belongs to that server;
  // asking again would let the user create a room somewhere they are not
  // looking, and then wonder where it went.
  const serverId = overrideServerId ?? switchServersStore.activeServerId ?? '';
  const workspaceId = workspacesStore.idOnServerInScope(serverId || null);
  const workspace = workspacesStore.workspaces.find((each) => each.id === workspaceId) ?? null;
  // Whether the private channel note applies: a platform that needs the
  // person as the channel's owner takes only a confirmed linked account.
  const { identities } = useMyIdentities(workspaceId);
  const server = switchServersStore.servers.find((s) => s.id === serverId) ?? null;
  const myUserId = switchServersStore.statusFor(serverId)?.user?.id ?? null;
  const queryClient = useQueryClient();

  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', workspaceId],
    queryFn: () => rpc.workspaces.listBridges(workspaceId as string),
    enabled: workspaceId !== null,
  });
  const tenantId = workspace?.tenantId ?? null;
  const rosterQuery = useQuery({
    queryKey: ['workspace-members', serverId, tenantId],
    queryFn: () => rpc.chats.workspaceMembers({ serverId, tenantId: tenantId as string }),
    enabled: tenantId !== null,
  });
  // Only an admin files a room in a group; for anyone else it is made with none.
  const administers = workspaceId !== null && administersWorkspaceById(workspaceId);
  const groupsQuery = useQuery({
    // The key every view reads the groups under, so they go stale and refresh together.
    queryKey: ['remote-room-groups', workspaceId],
    queryFn: () => rpc.workspaces.listRoomGroups(workspaceId as string),
    enabled: workspaceId !== null && administers,
  });
  // Without the server's group_chats flag there are no Switch Console rooms: a room is a bridged one.
  const consoleOffered = useFeatureFlags(serverId || null).group_chats;
  const localAgentIds = new Set(
    workspaceId === null
      ? []
      : agentsStore.agentsInWorkspace(workspaceId).map((local) => local.switchAgentId)
  );
  const bridgePeopleQuery = (bridgeId: string) => ({
    queryKey: ['bridge-people', workspaceId, bridgeId],
    queryFn: () =>
      rpc.workspaces.listBridgePeople({ workspaceId: workspaceId as string, bridgeId }),
  });

  function useAgents(bridged: boolean, groupId: string | null): CreateRoomAgents {
    const agentsQuery = useQuery({
      queryKey: ['remote-agents', workspaceId],
      queryFn: () => rpc.workspaces.listAgents(workspaceId as string),
      enabled: workspaceId !== null,
    });
    const allowedQuery = useQuery({
      queryKey: ['chat-agent-candidates', serverId, workspaceId, null, groupId],
      queryFn: () => rpc.chats.agentCandidates({ serverId, roomId: null, groupId }),
      enabled: serverId !== '',
    });
    const managedQuery = useManagedAgents(serverId || null);
    // The agents the server's invite rule lets this person put into a new room.
    const invitableQuery = useRoomAgentCandidates(workspaceId, null);
    const managedProviders = new Map(
      (managedQuery.data ?? []).map((managed) => [managed.agentId, managed.definition.provider])
    );
    const providerLabel = (agentId: string, knownType: string | null) =>
      managedProviders.has(agentId)
        ? agentProviderLabel(managedProviders.get(agentId))
        : (knownAgentTypeDisplayName(knownType) ?? agentProviderLabelFor(agentId, workspaceId));
    // A bridged room is driven from this install, so it takes only the agents
    // this install registered or manages, and the people Switch knows on its
    // app. A Switch Console room is driven through the server: the agents the
    // server says the person may use, and its people.
    const offered = bridged
      ? invitableAgents(agentsQuery.data ?? [], invitableQuery.data).filter(
          (remote) =>
            workspaceId !== null &&
            (managedProviders.has(remote.id) || localAgentIds.has(remote.id))
        )
      : addableAgents(agentsQuery.data ?? [], allowedQuery.data ?? []);
    const failed = agentsQuery.isError || (!bridged && allowedQuery.isError);
    return {
      offered: offered.map((agent) =>
        agentParticipant(agent, providerLabel(agent.id, agent.knownAgentType))
      ),
      all: agentsQuery.data ?? [],
      loading: agentsQuery.isLoading || (!bridged && allowedQuery.isLoading),
      loaded:
        agentsQuery.isSuccess &&
        !agentsQuery.isFetching &&
        (!bridged || !invitableQuery.isPending) &&
        (bridged || (allowedQuery.isSuccess && !allowedQuery.isFetching)),
      error: failed ? (agentsQuery.error ?? allowedQuery.error) : null,
      inviteError: bridged && invitableQuery.isError ? invitableQuery.error : null,
    };
  }

  function useBridgePeople(bridgeId: string | null) {
    return useQuery({
      ...bridgePeopleQuery(bridgeId ?? ''),
      enabled: workspaceId !== null && bridgeId !== null,
    });
  }

  const host: CreateRoomHost = {
    serverId,
    workspaceId,
    hasServer: server !== null,
    myUserId,
    administers,
    consoleOffered,
    appName: 'Console',
    bridges: bridgesQuery,
    roster: {
      ...rosterQuery,
      data: rosterQuery.data && addablePeople(rosterQuery.data, new Set([myUserId ?? ''])),
    },
    identities:
      identities?.map((each) => ({
        bridgeId: each.bridgeId,
        externalUserId: each.externalUserId,
        name: accountName(each),
        verified: each.verified,
      })) ?? null,
    groups: groupsQuery,
    useAgents,
    useBridgePeople,
    fetchBridgePeople: (bridgeId) => queryClient.fetchQuery(bridgePeopleQuery(bridgeId)),
    createChat: async (params) => {
      const chat = await rpc.chats.create(params);
      chatsStore.add(serverId, chat);
      sidebarStore.setGrouping('room');
      openRoomView(chat.roomId);
      return chat.roomId;
    },
    createRoom: async (params) => {
      const result = await rpc.workspaces.createRoom(params);
      if (result.kind !== 'created') return result;

      // Re-read the room state so the sidebar shows the room straight away
      // rather than at the next window focus. This goes through the sidebar's
      // own refresh rather than `refreshRoomState`, which only re-reads
      // membership for the agents the sidebar knew about when it last loaded —
      // an agent onboarded moments ago is not among them, so the room would
      // appear with nothing under it until the next reconcile.
      await refreshSidebarRoomState(true);

      // Open what was just created: listed in the sidebar, expanded in the
      // tree, and shown in the main panel. Creating a room and being left where
      // you were reads as if nothing happened — and the agent grouping does not
      // list rooms at all, so the new room would be nowhere on screen.
      sidebarStore.setGrouping('room');
      sidebarStore.ensureRoomExpanded(result.room.id);
      openRoomView(result.room.id);
      return result;
    },
    setCloseGuard,
    marks: CONSOLE_PARTICIPANT_MARKS,
    MessagingAppSelector,
    ConfirmButton,
  };

  return (
    <CreateRoomDialog
      host={host}
      startingAgentId={startingAgentId}
      onSuccess={onSuccess}
      onClose={onClose}
    />
  );
});
