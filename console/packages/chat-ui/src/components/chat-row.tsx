import { DoorOpen, Loader2, MessageSquare, MoreHorizontal } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useState } from 'react';
import type { ChatSummary } from '../contracts/chats';
import { BridgeIcon, type ChatHost, useChatHost } from '../host';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu';
import { RelativeTime } from '../primitives/relative-time';
import { SidebarMenuAction, SidebarMenuRow } from '../primitives/sidebar';
import { UNSAVED_CHAT_NAME } from '../stores/direct-chat-starter';
import { UnreadBadge } from './unread-badge';

/** Whether something is under way in the chat: a send from here, or an agent working. */
function chatBusy(host: ChatHost, serverId: string, chat: ChatSummary): boolean {
  const timeline = host.chats.timelines.peek(serverId, chat.roomId);
  if (timeline?.pending.some((send) => send.state === 'sending')) return true;
  return chat.agents.some(
    (agent) =>
      host.activities.peek(serverId, host.chats.tenantId, chat.roomId, agent.id)?.working ?? false
  );
}

/**
 * One chat in a list: its name, when it last moved or that it is busy, and
 * the app's own actions on it (a menu's items), if it offers any.
 */
export const ChatRow = observer(function ChatRow({
  serverId,
  chat,
  isActive,
  onOpen,
  actions,
}: {
  serverId: string;
  chat: ChatSummary;
  isActive: boolean;
  onOpen: () => void;
  /** The menu's items; null for a chat with no actions here. */
  actions: ReactNode | null;
}) {
  const host = useChatHost();
  const [menuOpen, setMenuOpen] = useState(false);
  const busy = chatBusy(host, serverId, chat);
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
        {actions !== null && (
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
            <DropdownMenuContent align="end">{actions}</DropdownMenuContent>
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

/** One room in a list: its messaging app, its name and how many of its messages wait. */
export function RoomRow({
  roomId,
  room,
  isActive,
  onOpen,
}: {
  roomId: string;
  room: { name: string; bridgeType: string | null; bridgeDisplayName: string | null };
  isActive: boolean;
  onOpen: () => void;
}) {
  const { hasBridgeIcon } = useChatHost();
  return (
    <SidebarMenuRow
      isActive={isActive}
      title={room.bridgeDisplayName ? `${room.name} · ${room.bridgeDisplayName}` : room.name}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
      className="h-[30px] py-0 text-[13px]"
    >
      {room.bridgeType && hasBridgeIcon(room.bridgeType) ? (
        <span className="shrink-0">
          <BridgeIcon bridgeType={room.bridgeType} size={17} />
        </span>
      ) : (
        <DoorOpen className="size-[17px] shrink-0 text-[var(--fg-icon)]" />
      )}
      <span className="min-w-0 flex-1 truncate">{room.name}</span>
      <UnreadBadge roomId={roomId} />
    </SidebarMenuRow>
  );
}
