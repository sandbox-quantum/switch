import { dropMedia } from '@switch-console/chat-ui/components/chat-attachments';
import { type ChatHost, ChatHostProvider } from '@switch-console/chat-ui/host';
import { CONSOLE_LINK_PREFIX } from '@switch-console/chat-ui/model/console-links';
import type { ReactNode } from 'react';
import { followConsoleLink } from '@renderer/features/deeplinks/console-link-handler';
import { navigateHome } from '@renderer/features/switch-servers/home-target';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { useAgentAccent } from '@renderer/lib/components/agent-accent';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { useTheme } from '@renderer/lib/hooks/useTheme';
import { events, rpc } from '@renderer/lib/ipc';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { appState } from '@renderer/lib/stores/app-state';
import { chatRemovedChannel, chatResetChannel } from '@shared/core/chats/chatEvents';
import { useChatPeople } from './chat-people';
import { directChats } from './start-direct-chat';
import { agentActivities } from './stores/activities';
import { chatsStore, chatTitler } from './stores/chats';

events.on(chatRemovedChannel, ({ serverId, roomId, reason }) => {
  if (reason === 'access') dropMedia((s, r) => s === serverId && r === roomId);
});
events.on(chatResetChannel, ({ serverId }) => dropMedia((s) => s === serverId));

/** The chat UI as Switch Console draws it, reaching Switch through the main process. */
export const consoleChatHost: ChatHost = {
  chats: chatsStore,
  activities: agentActivities,
  unsavedChat: (roomId) => directChats.unsavedChat(roomId),
  sent: (serverId, roomId, body) => void chatTitler.sent(serverId, roomId, body),
  draftOwner: (serverId) => ({
    userId: switchServersStore.statusFor(serverId)?.user?.id ?? null,
    workspaceId: workspacesStore.idOnServerInScope(serverId),
  }),
  commands: (serverId, roomId) => rpc.chats.commands(serverId, roomId),
  media: (serverId, roomId, uri) => rpc.chats.media({ serverId, roomId, uri }),
  // A link to a Console page moves the app there; an http(s) link leaves it through the confirm dialog.
  openLink: (href) =>
    href.startsWith(CONSOLE_LINK_PREFIX) ? followConsoleLink(href) : confirmOpenExternalLink(href),
  isModalOpen: () => modalStore.isOpen,
  toast: (each) => void toast(each),
  bridgePlatformLabel,
  hasBridgeIcon,
  useChatPeople,
  useGroupChats: (serverId) => useFeatureFlags(serverId).group_chats,
  useDarkMode: () => useTheme().effectiveTheme === 'emdark',
  useAgentAccent,
  AgentAvatar,
  BridgeIcon,
  confirm: (opts) =>
    new Promise<boolean>((resolve) => {
      showModal('confirmActionModal', {
        title: opts.title,
        description: opts.description,
        confirmLabel: opts.confirmLabel,
        onSuccess: () => resolve(true),
        onClose: () => resolve(false),
      });
    }),
  rename: ({ currentName }) =>
    new Promise<string | null>((resolve) => {
      showModal('renameChatModal', {
        currentName,
        onSuccess: (newName) => resolve(newName),
        onClose: () => resolve(null),
      });
    }),
  reconnectFeed: async (serverId) => void (await rpc.chats.connect(serverId)),
  restartSession: (sessionId) => rpc.sessions.restartAgent(sessionId),
  navigate: (target) => {
    if (target === 'home') {
      navigateHome();
    } else {
      const serverId = switchServersStore.activeServerId;
      if (!serverId) {
        navigateHome();
        return;
      }
      appState.navigation.navigate('managedAgent', {
        serverId,
        agentId: target.agent,
        name: '',
      });
    }
  },
  // On an agent's page the open chat is `roomId` and a group room opened there is `room`.
  isOpenChat: (roomId) => {
    const managedAgent = appState.navigation.viewParamsStore.managedAgent;
    return (
      appState.navigation.currentViewId === 'managedAgent' &&
      (managedAgent?.roomId === roomId || managedAgent?.room === roomId)
    );
  },
  leaveOpenChat: (roomId) => {
    if (appState.navigation.currentViewId !== 'managedAgent') return;
    const managedAgent = appState.navigation.viewParamsStore.managedAgent;
    if (managedAgent?.roomId !== roomId && managedAgent?.room !== roomId) return;
    appState.navigation.updateViewParams('managedAgent', (prev) => {
      const next = { ...prev };
      if (next.roomId === roomId) delete next.roomId;
      if (next.room === roomId) delete next.room;
      return next;
    });
  },
};

export function ConsoleChatHost({ children }: { children: ReactNode }) {
  return <ChatHostProvider host={consoleChatHost}>{children}</ChatHostProvider>;
}
