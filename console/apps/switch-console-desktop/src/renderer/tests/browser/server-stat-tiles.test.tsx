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

vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: { loaded: true, load: async () => {}, agentsOnServer: () => [{}, {}] },
}));

vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: { workspacesNotSignedIn: [], readableRoomsInWorkspace: () => [] },
}));

vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {
    idOnServerInScope: (serverId: string | null) => (serverId === 'server' ? 'workspace' : null),
  },
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { servers: [], statusFor: () => null },
}));

import { ServerStatTiles } from '@renderer/features/switch-servers/server-stat-tiles';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
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

it('counts the agents onboarded on the server', async () => {
  const tile = agentsTile(await render());
  expect(tile.querySelectorAll('p')[1].textContent).toBe('2');
});
