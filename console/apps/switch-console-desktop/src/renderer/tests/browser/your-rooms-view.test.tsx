/**
 * Rooms shows yours by default, as cards. Someone who can read more (an admin,
 * or public rooms) can switch to All rooms, which never offers a Switch
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
const serverState = vi.hoisted(() => ({ managed: false, canArchive: true }));

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
vi.mock('@switch-console/chat-ui/components/unread-badge', () => ({ UnreadBadge: () => null }));
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
      unreadCounts: new Map<string, number>(),
      unread(roomId: string) {
        return this.unreadCounts.get(roomId) ?? 0;
      },
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
    get servers() {
      return [{ id: 'srv', name: 'Server', managed: serverState.managed }];
    },
    statusFor: () => ({ connected: true, user: { id: 'me' } }),
  },
}));
// The store's own rule for "yours": owned, a member, or an agent of yours inside.
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    workspacesNotSignedIn: [],
    workspacesThatFailedToLoad: [],
    localMemberIds: () => [],
    // On a server Console runs, the sidebar lists every room.
    listedRoomsInWorkspace: () =>
      serverState.managed
        ? rooms.list.all
        : rooms.list.all.filter((room) => room.ownerId === 'me' || room.viewerIsMember),
    readableRoomsInWorkspace: () => rooms.list.all,
    noteRooms: () => {},
    roomPermissions: () => ({ canArchive: serverState.canArchive, canManage: false }),
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
    viewerIsRoomAdmin: false,
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
  serverState.managed = false;
  serverState.canArchive = true;
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
    chatsStore.archivedError = null;
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
  [...container.querySelectorAll('[data-room-card] h3')].map((h) => h.textContent);
// Fixture rooms are named after their ids; a channel's card titles it `#name`.
const cardFor = (id: string) => container.querySelector<HTMLElement>(`[data-room-card="${id}"]`)!;
const toggle = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label);
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());
};

it('lists your rooms by default, and drops a chat once you are removed from it', async () => {
  await render();
  expect(names()).toEqual(['bobs-chat', 'yaml-room']);
  await removeFromBobsChat();
  expect(names()).toEqual(['yaml-room']);
});

it('shows every room you can read under All rooms, never chats you are not in', async () => {
  await render();
  await act(async () => toggle('All rooms')!.click());
  expect(names()).toEqual(['bobs-chat', 'private-tool-room', '#public-slack', 'yaml-room']);
  await removeFromBobsChat();
  expect(names()).toEqual(['private-tool-room', '#public-slack', 'yaml-room']);
});

it('keeps Mine to your rooms on a server Console runs, where the sidebar lists them all', async () => {
  serverState.managed = true;
  await render();
  expect(names()).toEqual(['bobs-chat', 'yaml-room']);
});

it('says who owns a room and what is in it in words, and marks one only its people reach', async () => {
  rooms.list.all.push(
    room('mine-slack', {
      ownerId: 'me',
      bridgeType: 'slack',
      bridgeDisplayName: 'Slack',
      channelType: 'channel_private',
      connectedUserCount: 1,
    })
  );
  await render();
  const card = cardFor('mine-slack');
  expect(card.textContent).toContain('Owned by you');
  expect(card.textContent).toContain('2 agents');
  expect(card.textContent).toContain('1 person');
  expect(card.querySelector('[aria-label="Private"]')).not.toBeNull();
  // A room with no messaging app: the server's people count would read 0, so none is shown.
  expect(cardFor('yaml-room').textContent).not.toMatch(/people|person/);
});

it('offers archiving only where the server lets you', async () => {
  await render();
  expect(cardFor('yaml-room').querySelector('[aria-label="yaml-room actions"]')).not.toBeNull();
  serverState.canArchive = false;
  await act(async () => toggle('All rooms')!.click());
  expect(cardFor('yaml-room').querySelector('[aria-label="yaml-room actions"]')).toBeNull();
});

it('lists archived rooms under Archived, and brings one back from its menu', async () => {
  archivedRooms.list = [
    room('old-slack', {
      bridgeType: 'slack',
      bridgeDisplayName: 'Slack',
      archived: true,
      viewerIsMember: true,
    }),
  ];
  await render();
  await settle();
  await act(async () => toggle('Archived')!.click());
  await settle();
  expect(names()).toEqual(['#old-slack']);
  await act(async () =>
    cardFor('old-slack')
      .querySelector<HTMLButtonElement>('[aria-label="old-slack actions"]')!
      .click()
  );
  await settle();
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (each) => each.textContent === 'Unarchive'
  )!;
  await act(async () => item.click());
  expect(setRoomArchived).toHaveBeenCalledWith({
    workspaceId: 'ws',
    roomId: 'old-slack',
    archived: false,
  });
});

it('says so when the archived chats cannot be listed', async () => {
  runInAction(() => {
    chatsStore.archivedError = 'Your archived chats could not be listed.';
  });
  await render();
  await act(async () => toggle('Archived')!.click());
  expect(container.textContent).toContain('Your archived chats could not be listed.');
});

it('lists your own archived room under Mine even when the server says nothing of membership', async () => {
  archivedRooms.list = [room('my-old-room', { ownerId: 'me', archived: true })];
  await render();
  await settle();
  await act(async () => toggle('Archived')!.click());
  await settle();
  expect(names()).toEqual(['my-old-room']);
});

it('does not claim there are no archived rooms beside an error listing them', async () => {
  runInAction(() => {
    chatsStore.archivedError = 'Your archived chats could not be listed.';
  });
  await render();
  await settle();
  await act(async () => toggle('Archived')!.click());
  await settle();
  expect(container.textContent).not.toContain('No archived rooms.');
});

it('labels your unread messages on a room’s card as unread', async () => {
  runInAction(() => {
    (chatsStore as unknown as { unreadCounts: Map<string, number> }).unreadCounts.set(
      'bobs-chat',
      3
    );
  });
  await render();
  expect(cardFor('bobs-chat').textContent).toContain('3 unread');
  expect(cardFor('yaml-room').textContent).not.toContain('unread');
});

it('archives a room from its menu only once you confirm', async () => {
  await render();
  await act(async () =>
    cardFor('yaml-room')
      .querySelector<HTMLButtonElement>('[aria-label="yaml-room actions"]')!
      .click()
  );
  await settle();
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (each) => each.textContent === 'Archive'
  )!;
  await act(async () => item.click());
  await settle();
  expect(setRoomArchived).not.toHaveBeenCalled();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain('Archive yaml-room?');
  const confirm = [...dialog.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Archive'
  )!;
  await act(async () => confirm.click());
  expect(setRoomArchived).toHaveBeenCalledWith({
    workspaceId: 'ws',
    roomId: 'yaml-room',
    archived: true,
  });
});
