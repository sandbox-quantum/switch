import { observer } from 'mobx-react-lite';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { ChatHeader } from './components/chat-header';
import { ChatPanel, useAgentActivities } from './components/chat-panel';
import { chatsStore } from './stores/chats';

type ChatParams = { serverId: string; roomId: string; agentId: string | null };

const ChatTitlebar = observer(function ChatTitlebar() {
  const { params } = useParams('chat');
  const chat = chatsStore.chat(params.roomId);
  // Shared with the panel: the registry hands both the same activities.
  const activities = useAgentActivities(params.serverId, chat);
  return (
    <Titlebar
      leftSlot={
        <div className="flex min-w-0 flex-1 items-center pr-2">
          {chat ? (
            <ChatHeader serverId={params.serverId} chat={chat} activities={activities} />
          ) : (
            <span className="text-sm text-foreground-muted">Chat</span>
          )}
        </div>
      }
    />
  );
});

const ChatMainPanel = observer(function ChatMainPanel() {
  const { params } = useParams('chat');
  return (
    <ChatPanel
      key={`${params.serverId}:${params.roomId}`}
      serverId={params.serverId}
      roomId={params.roomId}
      agentId={params.agentId}
      showHeader={false}
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
