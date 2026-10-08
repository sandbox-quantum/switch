import { Loader2, MessageSquare, MoreHorizontal, Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Fragment, useState } from 'react';
import {
  SidebarGroup,
  SidebarItemMiniButton,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuRow,
} from '@renderer/features/sidebar/sidebar-primitives';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { SectionLabel } from '@renderer/lib/ui/label';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import type { ChatSummary } from '@shared/core/chats/chats';
import { sidebarAgents } from '../sidebar-agents';
import { agentActivities } from '../stores/activities';
import { chatsStore } from '../stores/chats';
import { chatActions } from './chat-actions';

/** Whether something is under way in the chat: a send from here, or an agent working. */
function chatBusy(serverId: string, chat: ChatSummary): boolean {
  const timeline = chatsStore.timelines.peek(serverId, chat.roomId);
  if (timeline?.pending.some((send) => send.state === 'sending') || timeline?.held) return true;
  return chat.agents.some(
    (agent) =>
      agentActivities.peek(serverId, chatsStore.tenantId, chat.roomId, agent.id)?.working ?? false
  );
}

const ChatRow = observer(function ChatRow({
  serverId,
  chat,
  agentId,
}: {
  serverId: string;
  chat: ChatSummary;
  agentId: string;
}) {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { params } = useParams('chat');
  const [menuOpen, setMenuOpen] = useState(false);
  const active = currentView === 'chat' && params.roomId === chat.roomId;
  const busy = chatBusy(serverId, chat);
  return (
    <SidebarMenuRow
      className="group/row justify-between"
      isActive={active}
      onClick={() => navigate('chat', { serverId, roomId: chat.roomId, agentId })}
    >
      <div className="flex h-6 min-w-0 flex-1 items-center gap-1 pl-4">
        <span className="flex size-6 shrink-0 items-center justify-center">
          <MessageSquare className="size-4 text-foreground-muted" />
        </span>
        <SidebarMenuAction aria-label={`Open chat ${chat.name}`} className="overflow-hidden">
          <span className="min-w-0 truncate">{chat.name}</span>
        </SidebarMenuAction>
      </div>
      <div className="ml-2 flex min-w-6 shrink-0 items-center justify-end gap-1">
        {!menuOpen && (
          <span className="flex items-center text-xs text-foreground-passive group-hover/row:hidden">
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" aria-label="Working" />
            ) : chat.lastMessage ? (
              <RelativeTime value={chat.lastMessage.sentAt} compact />
            ) : null}
          </span>
        )}
        <DropdownMenu onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            className={`${menuOpen ? 'flex' : 'hidden group-hover/row:flex'} size-6 items-center justify-center rounded-md text-foreground-tertiary-muted hover:bg-background-tertiary-2`}
            aria-label={`Actions for ${chat.name}`}
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {chatActions(serverId, chat).map((action) => (
              <Fragment key={action.key}>
                {action.separatorBefore && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  variant={action.destructive ? 'destructive' : 'default'}
                  onClick={action.run}
                >
                  {action.icon}
                  {action.label}
                </DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </SidebarMenuRow>
  );
});

function newChat(
  serverId: string,
  agentId: string | null,
  navigate: ReturnType<typeof useNavigate>['navigate']
) {
  showModal('newChatModal', {
    serverId,
    agentId,
    onSuccess: (chat: ChatSummary) =>
      navigate('chat', {
        serverId,
        roomId: chat.roomId,
        agentId: agentId ?? chat.agents[0]?.id ?? null,
      }),
  });
}

/**
 * The sidebar's Chats: each agent, and under it the chats it is in, newest
 * first. A chat in a room with several agents is listed under each of them.
 */
export const SidebarChats = observer(function SidebarChats() {
  const { navigate } = useNavigate();
  const serverId = chatsStore.serverId;
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  const workspaceAgents = useWorkspaceAgents(workspaceId);
  if (!serverId) return null;
  const meId = switchServersStore.statusFor(serverId)?.user?.id ?? null;
  const chats = [...chatsStore.chats.values()];
  const owned = (workspaceAgents.data ?? []).filter((agent) => meId && agent.ownerId === meId);
  const agents = sidebarAgents(chats, owned);
  return (
    <SidebarGroup className="mt-4 mb-0 flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pb-1">
        <SectionLabel>Chats</SectionLabel>
        <SidebarItemMiniButton
          aria-label="New chat"
          title="New chat"
          onClick={() => newChat(serverId, null, navigate)}
        >
          <Plus className="size-3.5" />
        </SidebarItemMiniButton>
      </div>
      {chatsStore.listError && (
        <p role="alert" className="px-4 py-1 text-xs text-foreground-destructive">
          {chatsStore.listError}
        </p>
      )}
      {workspaceAgents.error && (
        <p role="alert" className="px-4 py-1 text-xs text-foreground-warning">
          {failureText(workspaceAgents.error, 'Your agents could not be listed.')}
        </p>
      )}
      <SidebarMenu className="flex min-h-0 flex-1 flex-col gap-[2px] overflow-y-auto px-2">
        {agents.map((agent) => (
          <Fragment key={agent.id}>
            <SidebarMenuRow
              className="group/row justify-between"
              onClick={() => newChat(serverId, agent.id, navigate)}
            >
              <div className="flex h-6 min-w-0 flex-1 items-center gap-2">
                <AgentAvatar name={agent.name} iconUrl={agent.iconUrl} size={18} />
                <SidebarMenuAction
                  aria-label={`New chat with ${agent.name}`}
                  className="overflow-hidden"
                >
                  <span className="min-w-0 truncate">{agent.name}</span>
                </SidebarMenuAction>
              </div>
              <Plus className="hidden size-3.5 shrink-0 text-foreground-muted group-hover/row:block" />
            </SidebarMenuRow>
            {chatsStore.chatsOfAgent(agent.id).map((chat) => (
              <ChatRow key={chat.roomId} serverId={serverId} chat={chat} agentId={agent.id} />
            ))}
          </Fragment>
        ))}
        {agents.length === 0 && !workspaceAgents.isLoading && (
          <p className="px-2 py-2 text-xs text-foreground-muted">
            No chats yet. Start one with the + above.
          </p>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
});
