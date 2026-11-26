import type { ChatSummary } from '../contracts/chats';
import { chatRemovalNavigation } from '../model/chat-removal';
import { Archive, ArchiveRestore, LogOut, Pencil, Trash2 } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { failureText } from '../model/failures';
import { useChatHost } from '../host';
import { DropdownMenuItem, DropdownMenuSeparator } from '../primitives/dropdown-menu';

export type ChatAction = {
  key: string;
  label: string;
  icon: ReactNode;
  separatorBefore?: boolean;
  run: () => void;
};

async function attempt(run: () => Promise<void>, failure: string, toast: (t: { title: string; variant?: 'destructive' }) => void): Promise<void> {
  try {
    await run();
  } catch (error) {
    toast({ title: failureText(error, failure), variant: 'destructive' });
  }
}

export type ChatRemovalContext = {
  currentViewId: string;
  chatRoomId?: string;
  roomRoomId?: string;
  agentRoomId?: string;
};

function leaveIfOpen(roomId: string, context: ChatRemovalContext, host: ReturnType<typeof useChatHost>): void {
  const { leaveChatView } = chatRemovalNavigation(roomId, context);
  if (leaveChatView) host.navigate('home');
  if (host.isOpenChat(roomId)) host.leaveOpenChat(roomId);
}

export function confirmLeaveChat(
  serverId: string,
  chat: ChatSummary,
  context: ChatRemovalContext,
  host: ReturnType<typeof useChatHost>
): void {
  void (async () => {
    const confirmed = await host.confirm({
      title: `Leave ${chat.name}?`,
      description: 'You stop seeing its messages and it leaves your lists. Someone who manages it can add you back.',
      confirmLabel: 'Leave room',
    });
    if (!confirmed) return;
    try {
      await host.chats.leave(serverId, chat.roomId);
    } catch (error) {
      host.toast({ title: failureText(error, 'Could not leave the room.'), variant: 'destructive' });
      return;
    }
    leaveIfOpen(chat.roomId, context, host);
  })();
}

export function chatActions(
  serverId: string,
  chat: ChatSummary,
  context: ChatRemovalContext,
  host: ReturnType<typeof useChatHost>
): ChatAction[] {
  const leave: ChatAction = {
    key: 'leave',
    label: 'Leave room…',
    icon: <LogOut className="size-4" />,
    separatorBefore: true,
    run: () => confirmLeaveChat(serverId, chat, context, host),
  };
  if (!chat.canManage) return [leave];
  const { roomId } = chat;
  const actions: ChatAction[] = [];
  actions.push({
    key: 'rename',
    label: 'Rename…',
    icon: <Pencil className="size-4" />,
    run: () => void (async () => {
      const newName = await host.rename({ roomId, currentName: chat.name });
      if (!newName) return;
      await attempt(async () => {
        await host.chats.rename(serverId, roomId, newName);
      }, 'Could not rename the chat.', host.toast);
    })(),
  });
  actions.push(host.chats.archived.has(roomId)
      ? {
          key: 'unarchive',
          label: 'Unarchive',
          icon: <ArchiveRestore className="size-4" />,
          run: () =>
            void attempt(
              () => host.chats.unarchive(serverId, roomId),
              'Could not unarchive the chat.',
              host.toast
            ),
        }
      : {
          key: 'archive',
          label: 'Archive',
          icon: <Archive className="size-4" />,
          run: () =>
            void attempt(async () => {
              await host.chats.archive(serverId, roomId);
              leaveIfOpen(roomId, context, host);
            }, 'Could not archive the chat.', host.toast),
        });
  actions.push({
      key: 'delete',
      label: 'Delete chat…',
      icon: <Trash2 className="size-4" />,
      separatorBefore: true,
      run: () => void (async () => {
        const confirmed = await host.confirm({
          title: 'Delete this chat?',
          description: "This deletes the chat and its messages for everyone, including the agent. This can't be undone.",
          confirmLabel: 'Delete chat',
        });
        if (!confirmed) return;
        await attempt(async () => {
          await host.chats.delete(serverId, roomId);
          leaveIfOpen(roomId, context, host);
        }, 'Could not delete the chat.', host.toast);
      })(),
  });
  actions.push(leave);
  return actions;
}

export function ChatActionItems({ actions }: { actions: ChatAction[] }) {
  return actions.map((action, index) => (
    <Fragment key={action.key}>
      {action.separatorBefore && index > 0 && <DropdownMenuSeparator />}
      <DropdownMenuItem onClick={action.run}>
        {action.icon}
        {action.label}
      </DropdownMenuItem>
    </Fragment>
  ));
}
