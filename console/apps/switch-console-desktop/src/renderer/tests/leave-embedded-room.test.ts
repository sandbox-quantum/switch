// @vitest-environment jsdom
import type { ChatSummary } from '@switch-console/chat-ui/contracts/chats';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { runInAction } from 'mobx';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ConsoleChatHost } from '@renderer/features/chats/console-chat-host';
import { RoomConfigurationPanel } from '@renderer/features/switch-rooms/room-configuration-panel';
import { appState } from '@renderer/lib/stores/app-state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const leave = vi.hoisted(() => vi.fn(async () => {}));
const chat = vi.hoisted(
  (): ChatSummary => ({
    roomId: 'planning',
    name: 'Planning',
    channelType: 'channel_private',
    bridgeType: null,
    channelName: null,
    agents: [],
    canManage: false,
    ownsAgent: false,
    memberUserIds: ['u1', 'u2'],
    memberCount: 2,
    unreadCount: 0,
    lastMessage: null,
  })
);

vi.mock('@renderer/lib/ipc', () => ({ events: { on: () => () => {} }, rpc: {} }));
vi.mock('@renderer/features/chats/stores/chats', () => ({
  chatsStore: {
    serverId: 's',
    removed: new Set(),
    archived: new Set(),
    chat: (roomId: string) => (roomId === chat.roomId ? chat : undefined),
    leave,
  },
  chatTitler: { sent: vi.fn() },
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({
  showModal: (_id: string, props: { onSuccess: () => void }) => props.onSuccess(),
  useShowModal: () => vi.fn(),
}));

it('leaving a group room opened on an agent page clears it there and stays on the page', async () => {
  runInAction(() => {
    appState.navigation.navigate('managedAgent', { serverId: 's', agentId: 'a', name: 'Helper' });
    appState.navigation.updateViewParams('managedAgent', { room: 'planning' });
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(ConsoleChatHost, null, createElement(RoomConfigurationPanel, { roomId: 'planning' }))
      )
    )
  );

  const button = [...container.querySelectorAll('button')].find(
    (each) => each.textContent === 'Leave room…'
  );
  await act(async () => button!.click());
  await act(async () => await Promise.resolve());

  expect(leave).toHaveBeenCalledTimes(1);
  expect(leave).toHaveBeenCalledWith('s', 'planning');
  expect(appState.navigation.currentViewId).toBe('managedAgent');
  expect(appState.navigation.viewParamsStore.managedAgent?.room).toBeUndefined();
  expect(appState.navigation.viewParamsStore.managedAgent?.agentId).toBe('a');

  await act(async () => root.unmount());
  container.remove();
});
