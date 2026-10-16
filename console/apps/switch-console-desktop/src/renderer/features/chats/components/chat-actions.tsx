import { Archive, Pencil, Trash2 } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { DropdownMenuItem, DropdownMenuSeparator } from '@renderer/lib/ui/dropdown-menu';
import type { ChatSummary } from '@shared/core/chats/chats';
import { chatRemovalNavigation } from '../chat-removal';
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
    agentRoomId: navigation.viewParamsStore.managedAgent?.roomId,
  });
  if (leaveChatView) navigation.navigate('home');
  if (clearAgentChat) navigation.updateViewParams('managedAgent', { roomId: undefined });
}

/**
 * What can be done to a chat from its row or its header. Each acts on the room
 * for everyone in it, so each is offered only to its managers: the room's owner
 * or a workspace admin, the same rule the server applies.
 */
export function chatActions(serverId: string, chat: ChatSummary): ChatAction[] {
  if (!chat.canManage) return [];
  const { roomId } = chat;
  return [
    {
      key: 'rename',
      label: 'Rename',
      icon: <Pencil className="size-4" />,
      run: () => showModal('renameChatModal', { serverId, roomId, currentName: chat.name }),
    },
    {
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
