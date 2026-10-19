import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import type { ServiceGrants } from '@shared/core/switch-servers/service-grants';

const flags = vi.hoisted(() => ({ agent_chats: true, service_connections: true }));
const grants = vi.hoisted(() => ({ data: undefined as ServiceGrants | null | undefined }));

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
    fetchAgentRooms: async () => {},
    roomsFor: () => [],
    errorFor: () => null,
  },
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
vi.mock('@renderer/features/chats/components/chat-panel', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ChatPanel: () => null,
}));

import '@renderer/index.css';
import { AgentChats } from '@renderer/features/managed-agents/agent-chats';

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

/** The agent column's rows above the chats, by their labels. */
const navRows = () =>
  [...container.querySelectorAll<HTMLElement>('nav[aria-label="Agent"] > div')].map((row) => ({
    label: row.textContent?.trim() ?? '',
    row,
  }));
const navLabels = () => navRows().map(({ label }) => label);
const navItem = (label: string) => navRows().find((entry) => entry.label === label)!.row;

it("puts Connections in the agent's column, above Agent settings, and opens it there", async () => {
  await act(async () => root.render(<AgentChats agent={AGENT} />));
  expect(navLabels()).toEqual(['Connections', 'Agent settings']);

  await act(async () => navItem('Connections').click());
  expect(navigation.params().section).toBe('connections');
  expect(container.querySelector('[data-testid="connections"]')?.textContent).toBe(
    'Connections for pm-agent (agent-1)'
  );

  await act(async () => navItem('Agent settings').click());
  expect(container.querySelector('[data-testid="settings"]')?.textContent).toBe(
    'Settings, service access not shown'
  );
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
