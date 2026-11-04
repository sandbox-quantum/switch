import { Loader2, MessageSquare, MoreHorizontal } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { SidebarMenuAction, SidebarMenuRow } from '@renderer/features/sidebar/sidebar-primitives';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import type { ChatSummary } from '@shared/core/chats/chats';
import { agentActivities } from '../stores/activities';
import { chatsStore } from '../stores/chats';
import { UNSAVED_CHAT_NAME } from '../stores/direct-chat-starter';
import { ChatActionItems, chatActions } from './chat-actions';
import { UnreadBadge } from './unread-badge';

/** Whether something is under way in the chat: a send from here, or an agent working. */
function chatBusy(serverId: string, chat: ChatSummary): boolean {
  const timeline = chatsStore.timelines.peek(serverId, chat.roomId);
  if (timeline?.pending.some((send) => send.state === 'sending')) return true;
  return chat.agents.some(
    (agent) =>
      agentActivities.peek(serverId, chatsStore.tenantId, chat.roomId, agent.id)?.working ?? false
  );
}

/** One chat in a list: its name, when it last moved or that it is busy, and its actions. */
export const ChatRow = observer(function ChatRow({
  serverId,
  chat,
  isActive,
  onOpen,
}: {
  serverId: string;
  chat: ChatSummary;
  isActive: boolean;
  onOpen: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const busy = chatBusy(serverId, chat);
  const actions = chatActions(serverId, chat);
  return (
    <SidebarMenuRow className="group/row justify-between" isActive={isActive} onClick={onOpen}>
      <div className="flex h-6 min-w-0 flex-1 items-center gap-1">
        <span className="flex size-6 shrink-0 items-center justify-center">
          <MessageSquare className="size-4 text-foreground-muted" />
        </span>
        <SidebarMenuAction aria-label={`Open chat ${chat.name}`} className="overflow-hidden">
          <span className="min-w-0 truncate">{chat.name}</span>
        </SidebarMenuAction>
        <UnreadBadge roomId={chat.roomId} />
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
        {actions.length > 0 && (
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
              <ChatActionItems actions={actions} />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </SidebarMenuRow>
  );
});

/** A chat not sent yet, so with no room: only its draft, kept across restarts. */
export function UnsavedChatRow({ isActive, onOpen }: { isActive: boolean; onOpen: () => void }) {
  return (
    <SidebarMenuRow className="justify-between" isActive={isActive} onClick={onOpen}>
      <div className="flex h-6 min-w-0 flex-1 items-center gap-1">
        <span className="flex size-6 shrink-0 items-center justify-center">
          <MessageSquare className="size-4 text-foreground-muted" />
        </span>
        <SidebarMenuAction
          aria-label={`Open chat ${UNSAVED_CHAT_NAME}`}
          className="overflow-hidden"
        >
          <span className="min-w-0 truncate italic">{UNSAVED_CHAT_NAME}</span>
        </SidebarMenuAction>
      </div>
      <span className="ml-2 shrink-0 text-xs text-foreground-passive">Draft</span>
    </SidebarMenuRow>
  );
}
