import {
  type BuddySetupServices,
  BuddySetupCards as SharedBuddySetupCards,
} from '@switch-console/chat-ui/components/buddy-setup-cards';
import { consoleLink } from '@switch-console/chat-ui/model/console-links';
import { Button } from '@switch-console/chat-ui/primitives/button';
import { SwitchConsoleMark } from '@switch-console/chat-ui/primitives/switch-console-mark';
import { TermInfo } from '@switch-console/chat-ui/primitives/term-info';
import { useQueries, useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { followConsoleLink } from '@renderer/features/deeplinks/console-link-handler';
import { useMyIdentities } from '@renderer/features/switch-servers/use-my-identities';
import { BridgeIcon } from '@renderer/lib/components/bridge-icon';
import { CopyCommand } from '@renderer/lib/components/copy-command';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { reportOpenAttempt } from '@renderer/lib/open-external';
import { appState } from '@renderer/lib/stores/app-state';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import type { RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { typedCommand } from '@shared/core/switch-servers/typed-command';
import { buddyHandoffRefusal } from './buddy-setup-step';
import { ChatAppChecklist, useGroupProgress, useTalkedIn } from './chat-app-checklist';
import { BUDDY_CHAT_NAME, continueBuddyInChannel, resumeBuddyInChannel } from './open-buddy';

/** What the person says in the Welcome chat when they choose to stay in Console. */
export const BUDDY_STAY_MESSAGE = 'I’ll stay in Switch Console for now.';

/**
 * The setup cards under the greeting in the buddy's Welcome chat (the shared
 * `BuddySetupCards`), with Console's own ways to connect an app, link an
 * account and open a channel. Drawn only in the Welcome chat.
 */
export const BuddySetupCards = observer(function BuddySetupCards({
  serverId,
  workspaceId,
  agentId,
  agentName,
  roomId,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
  roomId: string;
}) {
  const chat = chatsStore.chat(roomId);
  if (!chat || chat.name !== BUDDY_CHAT_NAME || chat.bridgeType !== null) return null;
  return (
    <Cards
      serverId={serverId}
      workspaceId={workspaceId}
      agentId={agentId}
      agentName={agentName}
      roomId={roomId}
    />
  );
});

const Cards = observer(function Cards({
  serverId,
  workspaceId,
  agentId,
  agentName,
  roomId,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
  roomId: string;
}) {
  const showConnect = useShowModal('connectMessagingAppModal');
  const identities = useMyIdentities(workspaceId);
  const identitiesRefresh = identities.refresh;
  const showClaimIdentity = useShowModal('claimIdentityModal');
  const timeline = chatsStore.timelines.get(serverId, roomId);
  const stayed =
    timeline.messages.some(
      (message) => message.sender.kind === 'human' && message.body === BUDDY_STAY_MESSAGE
    ) || timeline.pending.some((send) => send.body === BUDDY_STAY_MESSAGE);

  const services: BuddySetupServices<RemoteBridge> = {
    scope: workspaceId,
    useBridges: () => {
      const query = useQuery({
        queryKey: ['remote-bridges', workspaceId],
        queryFn: () => rpc.workspaces.listBridges(workspaceId),
      });
      return { data: query.data ?? null, isError: query.isError, refetch: query.refetch };
    },
    useIdentities: () => identities,
    resume: (bridge, accountIds) => resumeBuddyInChannel(serverId, agentId, bridge, accountIds),
    handOff: (bridge, requestId) =>
      continueBuddyInChannel(serverId, { agentId }, bridge, requestId),
    refusalOf: buddyHandoffRefusal,
    failureText,
    roomChannel: async (id) => {
      const room = await rpc.workspaces.getRoomDetail({ workspaceId, roomId: id });
      return {
        channelName: room.linkedChannelName ?? null,
        channelUrl: room.externalChannelUrl ?? null,
        createdAt: room.createdAt ?? null,
      };
    },
    connect: (platform, onClosed) => showConnect({ serverId, platform, onClosed }),
    linkAccount: (bridge) => showClaimIdentity({ workspaceId, bridgeId: bridge.id }),
    manageLinkedAccounts: () => appState.navigation.navigate('settings', { tab: 'messaging-apps' }),
    openChannel: (url, label) =>
      void reportOpenAttempt(
        rpc.switchRooms.openRoomChannel({ channelUrl: url }),
        `Could not open ${label}`,
        url
      ),
    stay: {
      icon: <SwitchConsoleMark size={28} />,
      name: 'Switch Console',
      message: BUDDY_STAY_MESSAGE,
    },
    stayed,
    onStay: () =>
      timeline.send({
        body: BUDDY_STAY_MESSAGE,
        threadRootId: null,
        mentionAgentIds: [],
        mentionUserIds: [],
        mentionSpans: [],
        files: [],
        requestId: null,
      }),
    bridgeIcon: (bridgeType, size) => <BridgeIcon bridgeType={bridgeType} size={size} />,
    inviteCommand: (bridge, name) => (
      <CopyCommand command={typedCommand(bridge, 'invite-agent', { agent: name })} />
    ),
    checklist: (bridge, label) => (
      <ChatAppChecklist
        serverId={serverId}
        workspaceId={workspaceId}
        bridge={bridge}
        label={label}
        agentId={agentId}
        agentName={agentName}
        identities={identities.identities ?? []}
        onIdentitiesChanged={identitiesRefresh}
      />
    ),
    useTalking: ({ groupBridge, linked, channelRoomId }) => {
      const progress = useGroupProgress({
        workspaceId,
        agentId,
        bridge: groupBridge,
        enabled: linked,
      });
      const inChannel = useTalkedIn({ workspaceId, agentId, roomId: channelRoomId });
      return { inGroup: progress.talking, inChannel };
    },
    info: <TermInfo term="messagingApp" />,
    createdSince: (since) => (
      <CreatedSince workspaceId={workspaceId} buddyId={agentId} since={since} />
    ),
  };
  return <SharedBuddySetupCards services={services} agentId={agentId} agentName={agentName} />;
});

/**
 * The agents the person owns made since the hand-off, each with the rooms it is
 * in, linked to their pages here: what the buddy set up over in the chat app.
 * Nothing at all while there are none.
 */
const CreatedSince = observer(function CreatedSince({
  workspaceId,
  buddyId,
  since,
}: {
  workspaceId: string;
  buddyId: string;
  since: string;
}) {
  const agents = (useWorkspaceAgents(workspaceId).data ?? []).filter(
    (agent) =>
      agent.id !== buddyId &&
      agent.ownerId !== null &&
      agent.ownerId === chatsStore.userId &&
      Date.parse(agent.createdAt) > Date.parse(since)
  );
  const rooms = useQueries({
    queries: agents.map((agent) => ({
      queryKey: ['buddy-created-agent-rooms', workspaceId, agent.id],
      queryFn: () => rpc.workspaces.listAgentRooms({ workspaceId, agentId: agent.id }),
    })),
  });
  // Agents also sit in rooms made before the hand-off (a bridge's default channels): name only newer ones.
  const roomsQuery = useQuery({
    queryKey: ['remote-rooms', workspaceId],
    queryFn: () => rpc.workspaces.listRooms(workspaceId),
  });
  const newRoom = new Set(
    (roomsQuery.data ?? [])
      .filter((room) => Date.parse(room.createdAt) > Date.parse(since))
      .map((room) => room.id)
  );
  if (agents.length === 0) return null;
  const link = (label: string, url: string) => (
    <Button
      variant="link"
      size="sm"
      className="h-auto p-0 text-foreground underline underline-offset-2"
      onClick={() => followConsoleLink(url)}
    >
      {label}
    </Button>
  );
  return (
    <div data-testid="buddy-created-since" className="text-sm text-foreground-muted">
      Created since:{' '}
      {agents.map((agent, index) => (
        <span key={agent.id}>
          {index > 0 && ', '}
          {link(agent.displayName ?? agent.name, consoleLink('agent', { id: agent.id }))}
          {(rooms[index]?.data ?? [])
            .filter((room) => !room.archived && newRoom.has(room.roomId))
            .map((room) => (
              <span key={room.roomId}>
                {' · '}
                {link(room.roomName, consoleLink('room', { id: room.roomId }))} room
              </span>
            ))}
        </span>
      ))}
    </div>
  );
});
