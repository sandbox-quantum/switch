import { createElement, type ReactNode } from 'react';
import { type ChatHost, ChatHostProvider } from './host';
import type { AgentActivities } from './stores/chat-activity-store';
import type { ChatsStore } from './stores/chats-store';

/**
 * A host for drawing chat components in tests: no stores behind it unless a
 * test passes them, no network, plain avatars and icons, light mode.
 */
export function stubChatHost(overrides: Partial<ChatHost> = {}): ChatHost {
  return {
    chats: { userId: 'me' } as ChatsStore,
    activities: { peek: () => undefined, feedDown: new Map() } as unknown as AgentActivities,
    unsavedChat: () => undefined,
    sent: () => {},
    draftOwner: () => ({ userId: 'me', workspaceId: 'w' }),
    commands: async () => [],
    media: async () => {
      throw new Error('No media in this test.');
    },
    openLink: () => {},
    isModalOpen: () => false,
    toast: () => {},
    bridgePlatformLabel: (bridgeType) => bridgeType ?? 'messaging app',
    hasBridgeIcon: () => false,
    useChatPeople: () => ({ members: [], known: [] }),
    useGroupChats: () => true,
    useDarkMode: () => false,
    useAgentAccent: () => null,
    AgentAvatar: ({ name, iconUrl, size }) =>
      createElement('span', {
        'data-agent-avatar': name,
        'data-icon-url': iconUrl ?? undefined,
        style: { width: size, height: size },
      }),
    BridgeIcon: ({ bridgeType }) => createElement('span', { 'data-bridge-icon': bridgeType }),
    ...overrides,
  };
}

/** `children` drawn under {@link stubChatHost}. */
export function withChatHost(children: ReactNode, overrides: Partial<ChatHost> = {}) {
  return <ChatHostProvider host={stubChatHost(overrides)}>{children}</ChatHostProvider>;
}
