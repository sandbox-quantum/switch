/**
 * "Your Agents" counts the agents onboarded through Switch Console on the
 * server, the same ones the sidebar and the Your Agents page list.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { workspaces: { listBridges: async () => [] } },
}));

const managed = vi.hoisted(() => ({ data: undefined as unknown[] | undefined }));

vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: {
    loaded: true,
    load: async () => {},
    agentsOnServer: () => [{ switchAgentId: 'a' }, { switchAgentId: 'b' }],
    isMoved: () => false,
  },
}));

vi.mock('@renderer/features/managed-agents/use-managed-agents', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useManagedAgents: () => ({ data: managed.data, isLoading: false }),
}));

const roomsData = vi.hoisted(() => ({ rooms: [] as unknown[] }));

vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: { workspacesNotSignedIn: [], listedRoomsInWorkspace: () => roomsData.rooms },
}));

vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {
    idOnServerInScope: (serverId: string | null) => (serverId === 'server' ? 'workspace' : null),
    serverIdFor: (workspaceId: string) => (workspaceId === 'workspace' ? 'server' : null),
  },
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { servers: [], statusFor: () => null },
}));

const featureFlags = vi.hoisted(() => ({ agent_chats: false }));

vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => featureFlags,
}));

import { ServerStatTiles } from '@renderer/features/switch-servers/server-stat-tiles';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  managed.data = undefined;
  roomsData.rooms = [];
  featureFlags.agent_chats = false;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
});

async function render(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <ServerStatTiles serverId="server" />
      </QueryClientProvider>
    )
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return container;
}

function agentsTile(el: HTMLElement): HTMLElement {
  return [...el.querySelectorAll('p')].find((p) => p.textContent === 'Your Agents')!.parentElement!;
}

function roomsTile(el: HTMLElement): HTMLElement {
  return [...el.querySelectorAll('p')].find((p) => p.textContent === 'Your Rooms')!.parentElement!;
}

it('counts the agents onboarded on the server', async () => {
  const tile = agentsTile(await render());
  expect(tile.querySelectorAll('p')[1].textContent).toBe('2');
});

it('counts the agents the server runs too, once each, as the Your Agents page lists them', async () => {
  managed.data = [{ agentId: 'b' }, { agentId: 'c' }, { agentId: 'd' }];
  const tile = agentsTile(await render());
  expect(tile.querySelectorAll('p')[1].textContent).toBe('4');
});

it('hides 1-1 chats when agent_chats flag is on', async () => {
  roomsData.rooms = [
    { channelType: 'direct', bridgeType: null, agentCount: 1 },
    { channelType: 'group', bridgeType: null, agentCount: 2 },
  ];
  featureFlags.agent_chats = true;
  const tile = roomsTile(await render());
  expect(tile.querySelectorAll('p')[1].textContent).toBe('1');
});
