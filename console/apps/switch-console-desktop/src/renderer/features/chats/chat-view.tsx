import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { managedAgentLabel } from '@renderer/features/managed-agents/managed-agent-state';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { isConsoleGroupChatSummary } from '@renderer/features/switch-servers/room-filters';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { ChatHeaderControls, ChatHeaderTitle } from './components/chat-header';
import { ChatPanel, useAgentActivities } from './components/chat-panel';
import { agentChatsFlag } from './stores/agent-chats-flag';
import { chatsStore } from './stores/chats';

type ChatParams = { serverId: string; roomId: string; agentId: string | null };

const ChatTitlebar = observer(function ChatTitlebar() {
  const { params } = useParams('chat');
  const chat = chatsStore.chat(params.roomId);
  // Shared with the panel: the registry hands both the same activities.
  const activities = useAgentActivities(params.serverId, chat);
  return (
    <Titlebar
      leftClassName="min-w-0"
      leftSlot={
        <div className="flex min-w-0 items-center pr-2">
          {chat ? (
            <ChatHeaderTitle serverId={params.serverId} chat={chat} />
          ) : (
            <span className="text-sm text-foreground-muted">Chat</span>
          )}
        </div>
      }
      rightSlot={
        chat && (
          <ChatHeaderControls serverId={params.serverId} chat={chat} activities={activities} />
        )
      }
    />
  );
});

/**
 * With agent_chats off the chat view is not offered: a restored or linked chat
 * opens as main shows it, on the managed agent's page, else as a room.
 */
function useLeaveWhenChatsOff(params: ChatParams): boolean | undefined {
  const enabled = agentChatsFlag(params.serverId);
  const managed = useManagedAgents(params.serverId);
  const agent = managed.data?.find((each) => each.agentId === params.agentId);
  useEffect(() => {
    if (enabled !== false || managed.isLoading) return;
    appState.history.prune(
      (entry) =>
        entry.kind === 'view' &&
        entry.viewId === 'chat' &&
        (entry.params as { roomId?: string }).roomId === params.roomId
    );
    if (agent)
      appState.navigation.navigate('managedAgent', {
        serverId: params.serverId,
        agentId: agent.agentId,
        name: managedAgentLabel(agent),
      });
    else appState.navigation.navigate('room', { roomId: params.roomId });
  }, [enabled, managed.isLoading, agent, params.serverId, params.roomId]);
  return enabled;
}

/**
 * A group chat opens as a room, including a direct chat the moment it becomes
 * one; its draft and loaded messages are held by chat, so they come along.
 */
function useOpenGroupAsRoom(roomId: string): void {
  const chat = chatsStore.chat(roomId);
  const group = chat !== undefined && isConsoleGroupChatSummary(chat);
  useEffect(() => {
    if (!group) return;
    appState.history.prune(
      (entry) =>
        entry.kind === 'view' &&
        entry.viewId === 'chat' &&
        (entry.params as { roomId?: string }).roomId === roomId
    );
    appState.navigation.navigate('room', { roomId });
  }, [group, roomId]);
}

const ChatMainPanel = observer(function ChatMainPanel(): React.JSX.Element | null {
  const { params } = useParams('chat');
  const enabled = useLeaveWhenChatsOff(params);
  useOpenGroupAsRoom(params.roomId);
  if (enabled !== true) return null;
  return (
    <ChatPanel
      key={`${params.serverId}:${params.roomId}`}
      serverId={params.serverId}
      roomId={params.roomId}
    />
  );
});

/** A chat opened on its own: a room the person is a member of, with its agents' activity. */
export const chatView = {
  WrapView: ({ children }: ChatParams & { children: React.ReactNode }) => <>{children}</>,
  TitlebarSlot: ChatTitlebar,
  MainPanel: ChatMainPanel,
  canActivate: (params: unknown): GuardResult => {
    const value = (params ?? {}) as Partial<Record<keyof ChatParams, unknown>>;
    if (
      typeof value.serverId !== 'string' ||
      typeof value.roomId !== 'string' ||
      (value.agentId !== null && value.agentId !== undefined && typeof value.agentId !== 'string')
    )
      return { ok: false, redirect: 'home', discardParams: true };
    return { ok: true };
  },
} satisfies ViewDefinition<ChatParams>;
