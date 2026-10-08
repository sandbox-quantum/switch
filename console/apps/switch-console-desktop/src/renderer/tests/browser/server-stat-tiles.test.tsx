/**
 * "Your Agents" adds the cloud agents to the local ones. A server that has no
 * cloud agents counts them as zero; a server whose cloud list could not be
 * read leaves the total unknown and says so, rather than showing the local
 * agents alone as if they were all of them.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CloudAgent } from '@shared/core/cloud-agents/cloud-agents';

const sdkHost = vi.hoisted(() => ({ cloudAgents: vi.fn() }));

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { sdkHost, workspaces: { listBridges: async () => [] } },
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

function cloudAgent(): CloudAgent {
  return {
    key: 'cloud:server:launch',
    launch: {
      request_id: '00000000-0000-4000-8000-000000000001',
      name: 'reviewer',
      provider: 'claude',
      state: 'ready',
      desired_state: 'running',
      revision: 1,
      agent_id: 'agent',
      error: null,
      error_code: null,
      sleeping: false,
      machine_id: null,
      process_state: null,
      process_restarts: 0,
      oom_kills: 0,
    },
    machine: null,
    sessions: null,
    problem: null,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  sdkHost.cloudAgents.mockReset();
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

it('adds the cloud agents to the local ones', async () => {
  sdkHost.cloudAgents.mockResolvedValue([cloudAgent()]);
  const tile = agentsTile(await render());
  expect(tile.querySelectorAll('p')[1].textContent).toBe('3');
  expect(tile.querySelector('[role="alert"]')).toBeNull();
});

it('counts a server without cloud agents as having none', async () => {
  sdkHost.cloudAgents.mockResolvedValue(null);
  const tile = agentsTile(await render());
  expect(tile.querySelectorAll('p')[1].textContent).toBe('2');
  expect(tile.querySelector('[role="alert"]')).toBeNull();
});

it('leaves the total unknown and shows the failure when the cloud list fails', async () => {
  sdkHost.cloudAgents.mockRejectedValue(new Error('Request failed with status 500'));
  const tile = agentsTile(await render());
  expect(tile.querySelectorAll('p')[1].textContent).toBe('—');
  expect(tile.querySelector('[role="alert"]')?.textContent).toMatch(/cloud agents/i);
});
