import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import type { ServiceGrants } from '@shared/core/switch-servers/service-grants';
import type { RemoteAgentRoom } from '@shared/core/switch-servers/switch-servers';

const flags = vi.hoisted(() => ({ agent_chats: true, service_connections: true }));
const grants = vi.hoisted(() => ({ data: undefined as ServiceGrants | null | undefined }));
const rooms = vi.hoisted(() => ({
  list: [] as RemoteAgentRoom[],
  bridges: {} as Record<string, string>,
}));
const machine = vi.hoisted(() => ({ thisComputer: false }));

/** Stands in for the app's navigation: the agent column picks a section by setting params. */
const navigation = vi.hoisted(() => {
  let params: Record<string, string | undefined> = {};
  const listeners = new Set<() => void>();
  const set = (next: Record<string, string | undefined>) => {
    params = next;
    for (const listener of listeners) listener();
  };
  return {
    params: () => params,
    setParams: (update: Record<string, string | undefined>) => set({ ...params, ...update }),
    reset: (next: Record<string, string | undefined>) => set(next),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock('@renderer/lib/layout/navigation-provider', async (importOriginal) => {
  const { useSyncExternalStore } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({
      params: useSyncExternalStore(navigation.subscribe, navigation.params),
      setParams: navigation.setParams,
    }),
  };
});
vi.mock('@renderer/lib/hooks/useFeatureFlags', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useFeatureFlags: () => flags,
}));
vi.mock('@renderer/lib/ipc', () => ({ events: { on: () => () => {} }, rpc: {} }));
vi.mock('@renderer/lib/modal/modal-provider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showModal: vi.fn(),
}));
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    watchMembership: () => () => {},
    roomsFor: () => rooms.list,
    errorFor: () => null,
    roomNameById: () => undefined,
    roomBridgeTypeById: (roomId: string) => rooms.bridges[roomId] ?? null,
    roomSummaryById: () => undefined,
  },
}));
vi.mock('@renderer/features/switch-rooms/room-configuration-panel', () => ({
  RoomConfigurationPanel: (props: { roomId: string }) => (
    <div data-testid="room-configuration">Settings of {props.roomId}</div>
  ),
}));
vi.mock('@renderer/features/managed-agents/use-managed-agents', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRunsOnThisComputer: () => machine.thisComputer,
}));
vi.mock('@renderer/features/managed-agents/agent-connections-tab', () => ({
  useAgentServiceGrants: () => grants,
  AgentConnectionsTab: (props: { agentId: string; agentName: string }) => (
    <div data-testid="connections">
      Connections for {props.agentName} ({props.agentId})
    </div>
  ),
}));
vi.mock('@renderer/features/managed-agents/managed-agent-page', () => ({
  ManagedAgentPage: (props: { serviceGrants: boolean }) => (
    <div data-testid="settings">
      Settings, service access {props.serviceGrants ? 'shown' : 'not shown'}
    </div>
  ),
}));
// The profile's avatar asks the server whether third-party avatars are on.
vi.mock('@renderer/lib/stores/use-avatar-settings', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAvatarSettings: () => ({ thirdPartyAvatarsEnabled: null, error: null, retry: () => {} }),
}));
vi.mock('@renderer/features/chats/components/chat-panel', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ChatPanel: () => null,
}));

import '@renderer/index.css';
import { runInAction } from 'mobx';
import { directChats } from '@renderer/features/chats/start-direct-chat';
import { chatDraftKey, unsavedChatKey } from '@renderer/features/chats/stores/chat-drafts';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { AgentChats, openAgentChat } from '@renderer/features/managed-agents/agent-chats';
import { roomEmbedSlotStore } from '@renderer/features/switch-rooms/room-embed-slot';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { appState } from '@renderer/lib/stores/app-state';
import type { ChatSummary } from '@shared/core/chats/chats';

const AGENT: ManagedAgentView = {
  serverId: 'server-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  name: 'pm-agent',
  displayName: null,
  iconUrl: null,
  description: '',
  machine: null,
  desiredState: 'running',
  revision: 1,
  definition: {
    provider: 'claude',
    model: null,
    advancedConfig: {},
    instructions: '',
    autoApprove: false,
    autoMode: false,
    directory: null,
    isolation: 'shared',
  },
  status: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  flags.service_connections = true;
  grants.data = { grants: [], addressing_open: false };
  rooms.list = [];
  rooms.bridges = {};
  machine.thisComputer = false;
  navigation.reset({ serverId: 'server-1', agentId: 'agent-1', name: 'pm-agent' });
  container = document.createElement('div');
  container.style.width = '1100px';
  container.style.height = '700px';
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The section buttons under the agent's profile, by their labels. */
const navButtons = () => [
  ...container.querySelectorAll<HTMLButtonElement>('[role="toolbar"][aria-label="Agent"] button'),
];
const navLabels = () => navButtons().map((button) => button.getAttribute('aria-label'));
const navItem = (label: string) =>
  navButtons().find((button) => button.getAttribute('aria-label') === label)!;

it("puts Connectors under the agent's profile, before Agent settings, and opens it there", async () => {
  await act(async () => root.render(<AgentChats agent={AGENT} />));
  expect(navLabels()).toEqual(['Connectors', 'Agent settings']);
  expect(navItem('Connectors').getAttribute('aria-pressed')).toBe('false');

  await act(async () => navItem('Connectors').click());
  expect(navigation.params().section).toBe('connections');
  expect(navItem('Connectors').getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('[data-testid="connections"]')?.textContent).toBe(
    'Connections for pm-agent (agent-1)'
  );

  await act(async () => navItem('Agent settings').click());
  expect(navItem('Agent settings').getAttribute('aria-pressed')).toBe('true');
  expect(navItem('Connectors').getAttribute('aria-pressed')).toBe('false');
  expect(container.querySelector('[data-testid="settings"]')?.textContent).toBe(
    'Settings, service access not shown'
  );
});

it("shows the agent's name and where it runs at the top of its column", async () => {
  await act(async () =>
    root.render(
      <AgentChats
        agent={{
          ...AGENT,
          displayName: 'PM agent',
          machine: { id: 'machine-1', name: 'Max’s computer', kind: 'local', state: 'online' },
        }}
      />
    )
  );
  expect(container.querySelector('h2')?.textContent).toBe('PM agent');
  expect(container.textContent).toContain('Max’s computer');
});

it('calls the machine "This computer" when the agent runs here, keeping its name on hover', async () => {
  machine.thisComputer = true;
  await act(async () =>
    root.render(
      <AgentChats
        agent={{
          ...AGENT,
          machine: { id: 'machine-1', name: 'CC6G0XR0YF', kind: 'local', state: 'online' },
          status: {
            process: 'running',
            attached: true,
            reason: null,
            detail: null,
            directory: null,
          },
        }}
      />
    )
  );
  const line = container.querySelector<HTMLElement>('h2 + p')!;
  expect(line.textContent).toBe('This computer');
  expect(line.title).toContain('CC6G0XR0YF');
});

it('says so when the agent has no machine', async () => {
  await act(async () => root.render(<AgentChats agent={AGENT} />));
  expect(container.textContent).toContain('No machine');
});

it("leaves Connections out for an agent whose grants aren't yours, keeping service access in settings", async () => {
  grants.data = null;
  navigation.reset({ ...navigation.params(), section: 'connections' });
  await act(async () => root.render(<AgentChats agent={AGENT} />));
  expect(navLabels()).toEqual(['Agent settings']);
  expect(container.querySelector('[data-testid="connections"]')).toBeNull();

  await act(async () => navItem('Agent settings').click());
  expect(container.querySelector('[data-testid="settings"]')?.textContent).toBe(
    'Settings, service access shown'
  );
});

it('leaves Connections out when the server has service connections off', async () => {
  flags.service_connections = false;
  await act(async () => root.render(<AgentChats agent={AGENT} />));
  expect(navLabels()).toEqual(['Agent settings']);
});

const room = (roomId: string, roomName: string): RemoteAgentRoom => ({
  roomId,
  roomName,
  archived: false,
  status: 'live',
  roomRole: null,
});
/** A row in the agent's Rooms list, by the room's name. */
const roomRow = (name: string) =>
  [...container.querySelectorAll<HTMLElement>('section[aria-label="Rooms"] > div')].find(
    (row) => row.textContent?.trim() === name
  )!;
const embeddedRoom = () => container.querySelector<HTMLElement>('[data-testid="embedded-room"]');

it('opens a room in the right pane as the room view draws it, keeping its row selected', async () => {
  rooms.list = [room('room-1', 'design'), room('room-2', 'launch')];
  rooms.bridges = { 'room-1': 'slack', 'room-2': 'slack' };
  navigation.reset({ ...navigation.params(), room: 'room-1' });
  await act(async () => root.render(<AgentChats agent={AGENT} />));

  const pane = embeddedRoom()!;
  expect(pane).not.toBeNull();
  expect(roomEmbedSlotStore.slot?.roomId).toBe('room-1');
  expect(roomEmbedSlotStore.slot?.element).toBe(pane);
  // The conversation is laid over this box, so it has to fill the pane beside the column.
  const box = pane.getBoundingClientRect();
  expect(box.width).toBe(800);
  expect(box.height).toBe(700);
  expect(roomRow('design').hasAttribute('data-active')).toBe(true);
  expect(container.querySelector('[data-testid="agent-room-summary"]')).toBeNull();

  await act(async () => roomRow('launch').click());
  expect(navigation.params().room).toBe('room-2');
  expect(roomEmbedSlotStore.slot?.roomId).toBe('room-2');
  expect(roomRow('launch').hasAttribute('data-active')).toBe(true);
  expect(roomRow('design').hasAttribute('data-active')).toBe(false);
});

it('lets the room go when a section is picked or the page is left', async () => {
  rooms.list = [room('room-1', 'design')];
  rooms.bridges = { 'room-1': 'slack' };
  navigation.reset({ ...navigation.params(), room: 'room-1' });
  await act(async () => root.render(<AgentChats agent={AGENT} />));
  expect(roomEmbedSlotStore.slot?.roomId).toBe('room-1');

  await act(async () => navItem('Agent settings').click());
  expect(embeddedRoom()).toBeNull();
  expect(roomEmbedSlotStore.slot).toBeNull();
  expect(container.querySelector('[data-testid="settings"]')).not.toBeNull();

  await act(async () => roomRow('design').click());
  expect(navigation.params().section).toBeUndefined();
  expect(roomEmbedSlotStore.slot?.roomId).toBe('room-1');

  act(() => root.unmount());
  expect(roomEmbedSlotStore.slot).toBeNull();
  root = createRoot(container);
});

it("opens a room whose platform can't be drawn here on its settings", async () => {
  rooms.list = [room('room-1', 'design'), room('room-2', 'agents-only')];
  rooms.bridges = { 'room-1': 'slack' };
  navigation.reset({ ...navigation.params(), room: 'room-1' });
  await act(async () => root.render(<AgentChats agent={AGENT} />));
  expect(embeddedRoom()?.textContent).toBe('Settings of room-1');

  await act(async () => roomRow('agents-only').click());
  expect(embeddedRoom()?.textContent).toBe('Settings of room-2');
});

it('follows the open direct chat into its room when it becomes a group, not an older chat', async () => {
  const navigate = vi.spyOn(appState.navigation, 'navigate').mockImplementation(() => {});
  const agentInChat = {
    id: 'agent-1',
    name: 'pm-agent',
    displayName: null,
    iconUrl: null,
    provider: null,
    alias: null,
    ownerName: null,
    ownedByViewer: true,
  };
  const chat = (roomId: string, channelType: ChatSummary['channelType'], seq: number) =>
    ({
      roomId,
      name: roomId,
      channelType,
      bridgeType: null,
      channelName: null,
      agents: [agentInChat],
      canManage: true,
      ownsAgent: true,
      memberUserIds: [],
      memberCount: 1,
      unreadCount: 0,
      lastMessage: { seq, sentAt: `2026-01-0${seq}T00:00:00Z`, preview: '', senderName: '' },
    }) satisfies ChatSummary;
  try {
    runInAction(() => {
      chatsStore.serverId = 'server-1';
    });
    chatsStore.upsert(chat('older', 'direct', 1));
    chatsStore.upsert(chat('current', 'direct', 2));
    navigation.reset({
      serverId: 'server-1',
      agentId: 'agent-1',
      name: 'pm-agent',
      roomId: 'current',
    });
    await act(async () => root.render(<AgentChats agent={AGENT} />));
    expect(navigate).not.toHaveBeenCalled();

    // Someone adds a person: the open chat is now a group.
    await act(async () => chatsStore.upsert(chat('current', 'channel_private', 3)));
    expect(navigate).toHaveBeenCalledWith('room', { roomId: 'current' });
    expect(navigation.params().roomId).toBe('current');
  } finally {
    navigate.mockRestore();
    runInAction(() => {
      chatsStore.chats.delete('older');
      chatsStore.chats.delete('current');
      chatsStore.serverId = null;
    });
  }
});

it('opens no other chat in place of an unsaved one, so its header is not that chat’s', () => {
  const previous = {
    roomId: 'previous',
    name: 'QA review',
    channelType: 'direct',
    bridgeType: null,
    channelName: null,
    agents: [
      {
        id: 'agent-1',
        name: 'pm-agent',
        displayName: null,
        iconUrl: null,
        provider: null,
        alias: null,
        ownerName: null,
        ownedByViewer: true,
      },
    ],
    canManage: true,
    ownsAgent: true,
    memberUserIds: [],
    memberCount: 1,
    unreadCount: 0,
    lastMessage: null,
  } satisfies ChatSummary;
  try {
    runInAction(() => {
      chatsStore.serverId = 'server-1';
    });
    chatsStore.upsert(previous);
    const unsaved = directChats.start('server-1', 'agent-1');
    expect(openAgentChat(AGENT, unsaved)).toBeNull();
    expect(openAgentChat(AGENT, undefined)?.roomId).toBe('previous');
  } finally {
    runInAction(() => {
      chatsStore.chats.delete('previous');
      chatsStore.serverId = null;
    });
  }
});

it('lists an unsent New chat kept from before a restart, with its draft, and reopens it', async () => {
  const status = vi
    .spyOn(switchServersStore, 'statusFor')
    .mockReturnValue({ user: { id: 'user-a' } } as ReturnType<typeof switchServersStore.statusFor>);
  const workspace = vi.spyOn(workspacesStore, 'idOnServerInScope').mockReturnValue('ws-1');
  const scope = { serverId: 'server-1', userId: 'user-a', workspaceId: 'ws-1' };
  // An agent no other test opened a chat with: the starter is the app's own, shared by every test.
  const record = unsavedChatKey({ ...scope, agentId: 'agent-3' })!;
  try {
    localStorage.setItem(record, 'kept-request');
    localStorage.setItem(
      chatDraftKey({ ...scope, roomId: 'unsaved-chat:kept-request' }),
      JSON.stringify({ text: 'half a thought', mentions: [] })
    );
    navigation.reset({ serverId: 'server-1', agentId: 'agent-3', name: 'pm-agent' });
    await act(async () => root.render(<AgentChats agent={{ ...AGENT, agentId: 'agent-3' }} />));
    const row = container.querySelector<HTMLElement>('[aria-label="Open chat New Chat"]');
    expect(row).not.toBeNull();
    await act(async () => row!.click());
    expect(navigation.params().roomId).toBe('unsaved-chat:kept-request');

    // Emptied before the restart: there is nothing to come back to.
    act(() => root.unmount());
    root = createRoot(container);
    localStorage.removeItem(chatDraftKey({ ...scope, roomId: 'unsaved-chat:kept-request' }));
    navigation.reset({ serverId: 'server-1', agentId: 'agent-2', name: 'pm-agent' });
    localStorage.setItem(unsavedChatKey({ ...scope, agentId: 'agent-2' })!, 'emptied');
    await act(async () => root.render(<AgentChats agent={{ ...AGENT, agentId: 'agent-2' }} />));
    expect(container.querySelector('[aria-label="Open chat New Chat"]')).toBeNull();
    expect(localStorage.getItem(unsavedChatKey({ ...scope, agentId: 'agent-2' })!)).toBeNull();
  } finally {
    status.mockRestore();
    workspace.mockRestore();
    localStorage.clear();
  }
});

function directChat(agentId: string, roomId: string, name: string, seq: number | null) {
  return {
    roomId,
    name,
    channelType: 'direct',
    bridgeType: null,
    channelName: null,
    agents: [
      {
        id: agentId,
        name: 'pm-agent',
        displayName: null,
        iconUrl: null,
        provider: null,
        alias: null,
        ownerName: null,
        ownedByViewer: true,
      },
    ],
    canManage: true,
    ownsAgent: true,
    memberUserIds: [],
    memberCount: 1,
    unreadCount: 0,
    lastMessage:
      seq === null
        ? null
        : { seq, sentAt: `2026-01-0${seq}T00:00:00Z`, preview: '', senderName: '' },
  } satisfies ChatSummary;
}

/** The rows highlighted as open in the Direct chats list, by their text: a kept draft's ends in "Draft". */
const activeRows = () =>
  [...container.querySelectorAll('[data-active="true"]')].map((row) => row.textContent);

it('reopens the created chat whose first send failed, open before a reload, beside a kept draft', async () => {
  const status = vi
    .spyOn(switchServersStore, 'statusFor')
    .mockReturnValue({ user: { id: 'user-a' } } as ReturnType<typeof switchServersStore.statusFor>);
  const workspace = vi.spyOn(workspacesStore, 'idOnServerInScope').mockReturnValue('ws-1');
  const scope = { serverId: 'server-1', userId: 'user-a', workspaceId: 'ws-1' };
  const agent = { ...AGENT, agentId: 'agent-5' };
  try {
    // Another New chat with this agent, unsent, kept with its draft.
    localStorage.setItem(unsavedChatKey({ ...scope, agentId: 'agent-5' })!, 'other');
    localStorage.setItem(
      chatDraftKey({ ...scope, roomId: 'unsaved-chat:other' }),
      JSON.stringify({ text: 'another thought', mentions: [] })
    );
    runInAction(() => {
      chatsStore.serverId = 'server-1';
    });
    chatsStore.upsert(directChat('agent-5', 'made', 'New Chat', null));
    chatsStore.upsert(directChat('agent-5', 'newest', 'Newest', 5));
    navigation.reset({
      serverId: 'server-1',
      agentId: 'agent-5',
      name: 'pm-agent',
      roomId: 'made',
    });
    await act(async () => root.render(<AgentChats agent={agent} />));
    expect(navigation.params().roomId).toBe('made');
    expect(openAgentChat(agent, 'made')?.roomId).toBe('made');
    expect(activeRows()).toEqual(['New Chat']);
    expect(container.textContent).toContain('New ChatDraft');
    expect(directChats.unsavedChat('unsaved-chat:other')).toBeUndefined();
  } finally {
    status.mockRestore();
    workspace.mockRestore();
    localStorage.clear();
    runInAction(() => {
      chatsStore.chats.delete('made');
      chatsStore.chats.delete('newest');
      chatsStore.serverId = null;
    });
  }
});

it('reopens the unsent New chat that was open before a reload, not the newest chat', async () => {
  const status = vi
    .spyOn(switchServersStore, 'statusFor')
    .mockReturnValue({ user: { id: 'user-a' } } as ReturnType<typeof switchServersStore.statusFor>);
  const workspace = vi.spyOn(workspacesStore, 'idOnServerInScope').mockReturnValue('ws-1');
  const scope = { serverId: 'server-1', userId: 'user-a', workspaceId: 'ws-1' };
  // An agent no other test opened a chat with: the starter is the app's own, shared by every test.
  const agent = { ...AGENT, agentId: 'agent-4' };
  const roomId = 'unsaved-chat:open-before-reload';
  try {
    localStorage.setItem(unsavedChatKey({ ...scope, agentId: 'agent-4' })!, 'open-before-reload');
    localStorage.setItem(
      chatDraftKey({ ...scope, roomId }),
      JSON.stringify({ text: 'half a thought', mentions: [] })
    );
    // What navigation restored: the unsaved chat was the one open.
    navigation.reset({ serverId: 'server-1', agentId: 'agent-4', name: 'pm-agent', roomId });
    runInAction(() => {
      chatsStore.serverId = 'server-1';
    });
    chatsStore.upsert(directChat('agent-4', 'newest', 'Newest', 5));
    await act(async () => root.render(<AgentChats agent={agent} />));
    expect(directChats.unsavedChat(roomId)).toBeDefined();
    expect(navigation.params().roomId).toBe(roomId);
    expect(openAgentChat(agent, roomId)).toBeNull();
    // Only the open chat is highlighted.
    expect(activeRows()).toEqual(['New ChatDraft']);
  } finally {
    runInAction(() => {
      chatsStore.chats.delete('newest');
      chatsStore.serverId = null;
    });
    status.mockRestore();
    workspace.mockRestore();
    localStorage.clear();
  }
});

it('offers a new room or an existing one from the Rooms section, with the agent picked', async () => {
  const { showModal } = await import('@renderer/lib/modal/modal-provider');
  vi.mocked(showModal).mockClear();
  await act(async () => root.render(<AgentChats agent={AGENT} />));
  const add = container.querySelector<HTMLButtonElement>('[aria-label="Add to a room"]')!;
  await act(async () => add.click());
  const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items().map((item) => item.textContent)).toEqual(['New room', 'Add to existing room']);
  await act(async () => items()[0]!.click());
  expect(showModal).toHaveBeenCalledWith('createRoomModal', {
    serverId: 'server-1',
    agentId: 'agent-1',
  });
  await act(async () => add.click());
  await act(async () => items()[1]!.click());
  expect(showModal).toHaveBeenCalledWith('addAgentToRoomModal', {
    workspaceId: 'workspace-1',
    switchAgentId: 'agent-1',
    agentName: 'pm-agent',
  });
});
