import { MoreVertical, Power, PowerOff, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { ChatHeaderControls } from '@renderer/features/chats/components/chat-header';
import { useAgentActivities } from '@renderer/features/chats/components/chat-panel';
import {
  embeddedRoomFallbackTab,
  OpenInMessagingApp,
  RoomTabs,
} from '@renderer/features/switch-rooms/view';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import {
  ServerStatusPill,
  serverState,
} from '@renderer/features/switch-servers/server-presentation';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { TitlebarBreadcrumb } from '@renderer/lib/components/titlebar/titlebar-breadcrumb';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { AgentChats, openAgentChat, openAgentRoom, useAgentSection } from './agent-chats';
import { agentSectionLabel } from './agent-profile';
import { type AgentSection, isAgentSection } from './agent-sections';
import { ManagedAgentPage } from './managed-agent-page';
import { managedAgentLabel } from './managed-agent-state';
import { useManagedAgentActions } from './use-managed-agent-actions';
import { useManagedAgents } from './use-managed-agents';

type ManagedAgentParams = {
  serverId: string;
  agentId: string;
  name: string;
  /** The chat open on the agent's page. */
  roomId?: string;
  /** Shown instead of a chat when set. */
  section?: AgentSection;
  /** A room the agent is in, shown instead of a chat when set. */
  room?: string;
};

const ManagedAgentTitlebar = observer(function ManagedAgentTitlebar() {
  const { params } = useParams('managedAgent');
  const agents = useManagedAgents(params.serverId);
  const agent = agents.data?.find((listed) => listed.agentId === params.agentId) ?? null;
  const server = switchServersStore.servers.find((s) => s.id === params.serverId) ?? null;
  const label = agent ? managedAgentLabel(agent) : params.name;
  const chatsOn = useFeatureFlags(params.serverId).agent_chats;
  const { section } = useAgentSection(params.serverId, agent, params.section);
  const room = chatsOn && agent ? openAgentRoom(agent, params.room, section) : null;
  const chat = chatsOn && agent && !section && !room ? openAgentChat(agent, params.roomId) : null;
  const roomBridge = room && switchRoomsStore.roomBridgeTypeById(room);
  const activities = useAgentActivities(params.serverId, chat ?? undefined);
  const crumb = {
    key: 'agent',
    // Nothing until the agent is read: a stand-in drawn from its name
    // would be replaced by its own picture a moment later.
    icon: agent ? (
      <AgentAvatar
        name={label}
        iconUrl={agent.iconUrl}
        serverId={params.serverId}
        size={16}
        className="bg-transparent"
      />
    ) : (
      <span className="inline-block size-4 shrink-0" aria-hidden />
    ),
    label,
  };
  const pill = server && <ServerStatusPill server={server} />;
  if (!chatsOn)
    return (
      <Titlebar
        leftSlot={<TitlebarBreadcrumb crumbs={[crumb]} />}
        rightSlot={
          <div className="mr-1 flex items-center gap-1.5">
            {pill}
            {agent && <ManagedAgentActionsMenu agent={agent} />}
          </div>
        }
      />
    );
  return (
    <Titlebar
      className="pr-0"
      leftClassName="w-[300px] shrink-0 self-stretch border-r border-border [-webkit-app-region:drag]"
      rightClassName="min-w-0 flex-1 justify-between gap-3 self-stretch border-b border-border pr-[7px] pl-4 [-webkit-app-region:drag]"
      rightSlot={
        <>
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium">
              {room && hasBridgeIcon(roomBridge) && (
                <BridgeIcon bridgeType={roomBridge} size={16} />
              )}
              {section
                ? agentSectionLabel(section)
                : room
                  ? (switchRoomsStore.roomNameById(room) ?? room)
                  : chat?.name}
            </span>
            {room && (
              <span className="shrink-0 [-webkit-app-region:no-drag]">
                <RoomTabs roomId={room} fallback={embeddedRoomFallbackTab(room)} />
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
            {room && <OpenInMessagingApp roomId={room} />}
            {server &&
              serverState(server) !== 'connected' &&
              serverState(server) !== 'running-local' &&
              pill}
            {agent &&
              (chat ? (
                <ChatHeaderControls serverId={params.serverId} chat={chat} activities={activities}>
                  <ManagedAgentActionItems agent={agent} />
                </ChatHeaderControls>
              ) : (
                <ManagedAgentActionsMenu agent={agent} />
              ))}
          </div>
        </>
      }
    />
  );
});

/** Starting, stopping and deleting the agent, from the titlebar's menu as a Console agent's actions are. */
function ManagedAgentActionsMenu({ agent }: { agent: ManagedAgentView }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="size-7 p-0"
            aria-label={`${managedAgentLabel(agent)} actions`}
          >
            <MoreVertical className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <ManagedAgentActionItems agent={agent} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ManagedAgentActionItems({ agent }: { agent: ManagedAgentView }) {
  const { busy, setDesiredState, remove } = useManagedAgentActions(agent);
  const chatsOn = useFeatureFlags(agent.serverId).agent_chats;

  return (
    <>
      {agent.desiredState === 'running' ? (
        <DropdownMenuItem disabled={busy} onClick={() => void setDesiredState('stopped')}>
          <PowerOff className="size-4" />
          Turn off agent
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem disabled={busy} onClick={() => void setDesiredState('running')}>
          <Power className="size-4" />
          Turn on agent
        </DropdownMenuItem>
      )}
      {!chatsOn && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={busy} onClick={remove}>
            <Trash2 className="size-4" />
            Delete agent…
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

const ManagedAgentPanel = observer(function ManagedAgentPanel() {
  const { params } = useParams('managedAgent');
  const agents = useManagedAgents(params.serverId);
  const agent = agents.data?.find((listed) => listed.agentId === params.agentId);
  const chatsOn = useFeatureFlags(params.serverId).agent_chats;
  if (agents.error)
    return (
      <ServerPage width={900} title={params.name} description="">
        <p role="alert" className="text-sm text-destructive">
          {failureText(agents.error, 'The agent could not be read from its server.')}
        </p>
      </ServerPage>
    );
  if (agents.data === null)
    return (
      <ServerPage width={900} title={params.name} description="">
        <p role="alert" className="text-sm text-destructive">
          This server no longer runs managed agents.
        </p>
      </ServerPage>
    );
  if (!agents.data)
    return (
      <ServerPage width={900} title={params.name} description="Loading…">
        {null}
      </ServerPage>
    );
  if (!agent)
    return (
      <ServerPage width={900} title={params.name} description="">
        <p role="alert" className="text-sm text-destructive">
          This agent is no longer on its Switch server.
        </p>
      </ServerPage>
    );
  if (!chatsOn) return <ManagedAgentPage key={agent.agentId} agent={agent} serviceGrants />;
  return <AgentChats key={agent.agentId} agent={agent} />;
});

export const managedAgentView = {
  WrapView: ({ children }: ManagedAgentParams & { children: ReactNode }) => <>{children}</>,
  TitlebarSlot: ManagedAgentTitlebar,
  MainPanel: ManagedAgentPanel,
  canActivate: (params: unknown): GuardResult => {
    const value = (params ?? {}) as Partial<Record<keyof ManagedAgentParams, unknown>>;
    if (
      typeof value.serverId !== 'string' ||
      typeof value.agentId !== 'string' ||
      typeof value.name !== 'string' ||
      (value.roomId !== undefined && typeof value.roomId !== 'string') ||
      (value.section !== undefined && !isAgentSection(value.section)) ||
      (value.room !== undefined && typeof value.room !== 'string')
    )
      return { ok: false, redirect: 'home', discardParams: true };
    return { ok: true };
  },
} satisfies ViewDefinition<ManagedAgentParams>;
