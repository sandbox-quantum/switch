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
import { AgentChats } from '@renderer/features/managed-agents/agent-chats';
import { roomEmbedSlotStore } from '@renderer/features/switch-rooms/room-embed-slot';

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
  rooms.bridges = { 'room-1': 'mattermost', 'room-2': 'mattermost' };
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
  // A Mattermost room opens on its conversation, which leaves the box to the layer.
  expect(container.querySelector('[data-testid="room-configuration"]')).toBeNull();

  await act(async () => roomRow('launch').click());
  expect(navigation.params().room).toBe('room-2');
  expect(roomEmbedSlotStore.slot?.roomId).toBe('room-2');
  expect(roomRow('launch').hasAttribute('data-active')).toBe(true);
  expect(roomRow('design').hasAttribute('data-active')).toBe(false);
});

it('lets the room go when a section is picked or the page is left', async () => {
  rooms.list = [room('room-1', 'design')];
  rooms.bridges = { 'room-1': 'mattermost' };
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
