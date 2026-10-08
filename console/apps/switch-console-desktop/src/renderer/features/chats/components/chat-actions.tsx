import { Archive, EyeOff, LogOut, Pencil, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import type { ChatSummary } from '@shared/core/chats/chats';
import { chatsStore } from '../stores/chats';

export type ChatAction = {
  key: string;
  label: string;
  icon: ReactNode;
  destructive?: boolean;
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

/** Leave the chat view if it shows this room. */
function leaveIfOpen(roomId: string): void {
  const navigation = appState.navigation;
  if (navigation.currentViewId === 'chat' && navigation.viewParamsStore.chat?.roomId === roomId)
    navigation.navigate('home');
}

/**
 * What can be done to a chat from its row or its header. Rename and archive
 * change the room for everyone, so they are offered only to its managers;
 * removing it from the list is the person's own and comes back with the next
 * message; leaving takes their membership away.
 */
export function chatActions(serverId: string, chat: ChatSummary): ChatAction[] {
  const actions: ChatAction[] = [
    {
      key: 'members',
      label: 'Members',
      icon: <Users className="size-4" />,
      run: () => showModal('chatMembersModal', { serverId, roomId: chat.roomId }),
    },
  ];
  if (chat.canManage)
    actions.push({
      key: 'rename',
      label: 'Rename',
      icon: <Pencil className="size-4" />,
      run: () =>
        showModal('renameChatModal', { serverId, roomId: chat.roomId, currentName: chat.name }),
    });
  actions.push({
    key: 'hide',
    label: 'Remove from my list',
    icon: <EyeOff className="size-4" />,
    separatorBefore: true,
    run: () =>
      void attempt(async () => {
        await rpc.chats.hide(serverId, chat.roomId);
        chatsStore.hide(chat.roomId);
        leaveIfOpen(chat.roomId);
      }, 'Could not remove the chat from your list.'),
  });
  if (chat.canManage)
    actions.push({
      key: 'archive',
      label: 'Archive room',
      icon: <Archive className="size-4" />,
      destructive: true,
      run: () =>
        showModal('confirmActionModal', {
          title: `Archive ${chat.name}?`,
          description:
            'The room is archived for everyone in it, including the people who reach it from a messaging app.',
          confirmLabel: 'Archive',
          variant: 'destructive',
          onSuccess: () =>
            void attempt(async () => {
              await rpc.chats.archive(serverId, chat.roomId);
              chatsStore.hide(chat.roomId);
              leaveIfOpen(chat.roomId);
            }, 'Could not archive the room.'),
        }),
    });
  actions.push({
    key: 'leave',
    label: 'Leave chat',
    icon: <LogOut className="size-4" />,
    destructive: true,
    run: () =>
      showModal('confirmActionModal', {
        title: `Leave ${chat.name}?`,
        description: 'You stop seeing this chat. Someone who manages it can invite you back.',
        confirmLabel: 'Leave',
        variant: 'destructive',
        onSuccess: () =>
          void attempt(async () => {
            const userId = switchServersStore.statusFor(serverId)?.user?.id;
            if (!userId) throw new Error('Sign in to this server again to leave the chat.');
            await rpc.chats.removeMember(serverId, chat.roomId, userId);
            chatsStore.remove(chat.roomId);
            leaveIfOpen(chat.roomId);
          }, 'Could not leave the chat.'),
      }),
  });
  return actions;
}
