import { Archive, ArchiveRestore, LogOut, Pencil, Trash2 } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { DropdownMenuItem, DropdownMenuSeparator } from '@renderer/lib/ui/dropdown-menu';
import type { ChatSummary } from '@shared/core/chats/chats';
import { chatRemovalNavigation } from '../chat-removal';
import { chatFailure } from '../stores/chat-errors';
import { chatsStore } from '../stores/chats';

export type ChatAction = {
  key: string;
  label: string;
  icon: ReactNode;
  separatorBefore?: boolean;
  run: () => void;
};

async function attempt(run: () => Promise<void>, failure: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    toast({ title: failureText(error, failure), variant: 'destructive' });
  }
}

/** Leave the chat view if it shows this room, and close it on an agent's page. */
function leaveIfOpen(roomId: string): void {
  const navigation = appState.navigation;
  const { leaveChatView, clearAgentChat } = chatRemovalNavigation(roomId, {
    currentViewId: navigation.currentViewId,
    chatRoomId: navigation.viewParamsStore.chat?.roomId,
    roomRoomId: (navigation.viewParamsStore.room as { roomId?: string } | undefined)?.roomId,
    agentRoomId: navigation.viewParamsStore.managedAgent?.roomId,
  });
  if (leaveChatView) navigation.navigate('home');
  if (clearAgentChat) navigation.updateViewParams('managedAgent', { roomId: undefined });
}

/**
 * Leave a chat after asking: it goes from the lists and its open view closes.
 * A refusal, such as owning an agent in it, leaves everything as it was and
 * says why.
 */
export function confirmLeaveChat(serverId: string, chat: ChatSummary): void {
  showModal('confirmActionModal', {
    title: `Leave ${chat.name}?`,
    description:
      'You stop seeing its messages and it leaves your lists. Someone who manages it can add you back.',
    confirmLabel: 'Leave room',
    onSuccess: () =>
      void (async () => {
        try {
          await chatsStore.leave(serverId, chat.roomId);
        } catch (error) {
          toast({ title: chatFailure(error).message, variant: 'destructive' });
          return;
        }
        leaveIfOpen(chat.roomId);
      })(),
  });
}

/**
 * What can be done to a chat from its row or its header. Leaving is anyone's;
 * the rest act on the room for everyone in it, so each is offered only to its
 * managers: the room's owner or a workspace admin, the same rule the server
 * applies.
 */
export function chatActions(serverId: string, chat: ChatSummary): ChatAction[] {
  const leave: ChatAction = {
    key: 'leave',
    label: 'Leave room…',
    icon: <LogOut className="size-4" />,
    separatorBefore: true,
    run: () => confirmLeaveChat(serverId, chat),
  };
  if (!chat.canManage) return [leave];
  const { roomId } = chat;
  return [
    {
      key: 'rename',
      label: 'Rename',
      icon: <Pencil className="size-4" />,
      run: () => showModal('renameChatModal', { serverId, roomId, currentName: chat.name }),
    },
    chatsStore.archived.has(roomId)
      ? {
          key: 'unarchive',
          label: 'Unarchive',
          icon: <ArchiveRestore className="size-4" />,
          run: () =>
            void attempt(
              () => chatsStore.unarchive(serverId, roomId),
              'Could not unarchive the chat.'
            ),
        }
      : {
          key: 'archive',
          label: 'Archive',
          icon: <Archive className="size-4" />,
          run: () =>
            void attempt(async () => {
              await chatsStore.archive(serverId, roomId);
              leaveIfOpen(roomId);
            }, 'Could not archive the chat.'),
        },
    {
      key: 'delete',
      label: 'Delete chat…',
      icon: <Trash2 className="size-4" />,
      separatorBefore: true,
      run: () =>
        showModal('confirmActionModal', {
          title: 'Delete this chat?',
          description:
            "This deletes the chat and its messages for everyone, including the agent. This can't be undone.",
          confirmLabel: 'Delete chat',
          onSuccess: () =>
            void attempt(async () => {
              await chatsStore.delete(serverId, roomId);
              leaveIfOpen(roomId);
            }, 'Could not delete the chat.'),
        }),
    },
    leave,
  ];
}

/** A chat's actions as dropdown menu items. */
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
