/**
 * Your Rooms lists the rooms the sidebar lists. Someone who can read more (an
 * admin, or public rooms) can switch to All rooms, which never offers a Switch
 * Console chat they are not in: the server would not open it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable, runInAction } from 'mobx';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const rooms = vi.hoisted(() => ({ list: null as unknown as { all: RemoteRoomSummary[] } }));
const archivedRooms = vi.hoisted(() => ({ list: [] as RemoteRoomSummary[] }));
const setRoomArchived = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { workspaces: { listArchivedRooms: async () => archivedRooms.list, setRoomArchived } },
}));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({ params: { serverId: 'srv' } }),
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => () => {} }));
vi.mock('@renderer/features/sidebar/sidebar-tree-data', () => ({
  refreshSidebarRoomState: async () => {},
  refreshSidebarRoomStateAfterOnboarding: async () => {},
}));
vi.mock('@renderer/features/switch-rooms/open-room', () => ({ openRoom: async () => {} }));
vi.mock('@renderer/features/chats/components/unread-badge', () => ({ UnreadBadge: () => null }));
// The chats the user is in, as GET /gateway/chats lists them.
vi.mock('@renderer/features/chats/stores/chats', async () => {
  const { observable } = await import('mobx');
  return {
    chatsStore: observable({
      serverId: 'srv',
      chats: new Map<string, unknown>(),
      unlisted: new Set<string>(),
      archived: new Map<string, unknown>(),
      archivedError: null,
    }),
  };
});
vi.mock('@renderer/lib/stores/use-workspace-agents', () => ({
  useWorkspaceAgents: () => ({ data: [] }),
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: { agentsOnServer: () => [] },
}));
vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ agent_chats: true, group_chats: true }),
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {
    idOnServerInScope: () => 'ws',
    serverIdFor: () => 'srv',
    activeId: 'ws',
  },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    servers: [{ id: 'srv', name: 'Server' }],
    statusFor: () => ({ connected: true, user: { id: 'me' } }),
  },
}));
// The store's own rule for "yours": owned, a member, or an agent of yours inside.
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    workspacesNotSignedIn: [],
    workspacesThatFailedToLoad: [],
    localMemberIds: () => [],
    listedRoomsInWorkspace: () =>
      rooms.list.all.filter((room) => room.ownerId === 'me' || room.viewerIsMember),
    readableRoomsInWorkspace: () => rooms.list.all,
    noteRooms: () => {},
    roomPermissions: () => ({ canWrite: true, canManage: false }),
    refreshRoomState: async () => {},
  },
}));

import { chatsStore } from '@renderer/features/chats/stores/chats';
import { serverRoomsView } from '@renderer/features/switch-servers/server-rooms-view';

function room(id: string, extra: Partial<RemoteRoomSummary>): RemoteRoomSummary {
  return {
    id,
    name: id,
    description: '',
    channelType: 'group',
    agentCount: 2,
    bridgeDisplayName: null,
    bridgeType: null,
    externalChannelUrl: null,
    ownerId: 'bob',
    viewerIsMember: false,
    isConsoleChat: false,
    archived: false,
    createdAt: '',
    ...extra,
  };
}

let container: HTMLDivElement;
let root: Root;

function chat(id: string) {
  return {
    roomId: id,
    name: id,
    channelType: 'channel_private',
    bridgeType: null,
    agents: [{ id: 'a1' }, { id: 'a2' }],
    lastMessage: null,
  };
}

beforeEach(() => {
  archivedRooms.list = [];
  setRoomArchived.mockClear();
  rooms.list = observable({
    all: [
      room('bobs-chat', {
        viewerIsMember: true,
        channelType: 'channel_private',
        isConsoleChat: true,
      }),
      // The room list says "member" because the user's agent is in it; the user is not in the chat.
      room('agent-only-chat', {
        viewerIsMember: true,
        channelType: 'channel_private',
        isConsoleChat: true,
      }),
      // A private room made from YAML or a tool, not a chat: the usual rules apply.
      room('yaml-room', { viewerIsMember: true, channelType: 'channel_private' }),
      room('strangers-chat', { channelType: 'channel_private', isConsoleChat: true }),
      room('private-tool-room', { channelType: 'channel_private' }),
      room('public-slack', { bridgeType: 'slack', bridgeDisplayName: 'Slack' }),
    ],
  });
  runInAction(() => {
    chatsStore.chats.clear();
    chatsStore.chats.set('bobs-chat', chat('bobs-chat') as never);
  });
});

const removeFromBobsChat = () =>
  act(async () =>
    runInAction(() => {
      chatsStore.chats.delete('bobs-chat');
      rooms.list.all[0].viewerIsMember = false;
    })
  );

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const Panel = serverRoomsView.MainPanel;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Panel />
      </QueryClientProvider>
    )
  );
}

const names = () =>
  [...container.querySelectorAll('tbody tr td:first-child span.truncate')].map(
    (s) => s.textContent
  );
const toggle = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label);

it('lists your rooms by default, and drops a chat once you are removed from it', async () => {
  await render();
  expect(names()).toEqual(['bobs-chat', 'yaml-room']);
  await removeFromBobsChat();
  expect(names()).toEqual(['yaml-room']);
});

it('shows every room you can read under All rooms, never chats you are not in', async () => {
  await render();
  await act(async () => toggle('All rooms')!.click());
  expect(names()).toEqual(['bobs-chat', 'private-tool-room', 'public-slack', 'yaml-room']);
  await removeFromBobsChat();
  expect(names()).toEqual(['private-tool-room', 'public-slack', 'yaml-room']);
});

it('keeps the same columns in both, and marks a room only its people reach', async () => {
  await render();
  const headers = [...container.querySelectorAll('thead th')].map((th) => th.textContent);
  expect(headers).toEqual([
    'Room',
    'Messaging app',
    'Group',
    'Owner',
    'Access',
    'Agents · people',
    'Created',
  ]);
  expect(container.querySelector('[aria-label="Private channel"]')).not.toBeNull();
});

it('lists archived rooms under Archived, and brings one back', async () => {
  archivedRooms.list = [
    room('old-slack', {
      bridgeType: 'slack',
      bridgeDisplayName: 'Slack',
      archived: true,
      viewerIsMember: true,
    }),
  ];
  await render();
  for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());
  await act(async () => toggle('Archived')!.click());
  for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());
  expect(names()).toEqual(['old-slack']);
  await act(async () => toggle('Unarchive')!.click());
  expect(setRoomArchived).toHaveBeenCalledWith({
    workspaceId: 'ws',
    roomId: 'old-slack',
    archived: false,
  });
});
