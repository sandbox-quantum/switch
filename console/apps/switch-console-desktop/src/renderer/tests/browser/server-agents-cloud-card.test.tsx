/**
 * A cloud agent's card on Your Agents reads the same start attempt as the
 * sidebar: while a new session is being started the card says so, and a start
 * whose reply was lost is shown as not yet known, with Check again (the same
 * session, never a second one) or, once the session exists, Open.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CloudAgent } from '@shared/core/cloud-agents/cloud-agents';

const sdkHost = vi.hoisted(() => ({
  cloudAgents: vi.fn(),
  cloudSessions: vi.fn(),
  cloudSessionOperation: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { sdkHost, switchServers: {} },
}));

vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: { agentsOnServer: () => [] },
}));

vi.mock('@renderer/features/sidebar/sidebar-tree-data', () => ({
  refreshSidebarRoomState: async () => {},
  refreshSidebarRoomStateAfterOnboarding: async () => {},
}));

vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: { serversNotSignedIn: [], roomNameById: () => null },
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { servers: [], statusFor: () => null },
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate }),
  useParams: () => ({ params: { serverId: 'server' } }),
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: () => () => {},
}));

vi.mock('@renderer/lib/stores/use-remote-agents', () => ({
  useAgentIconUrl: () => null,
}));

import {
  cloudOperationAttempts,
  startAttemptKey,
} from '@renderer/features/cloud-agents/cloud-operation-attempts';
import { serverAgentsView } from '@renderer/features/switch-servers/server-agents-view';

const agentKey = 'cloud:server:00000000-0000-4000-8000-000000000001';

function agent(): CloudAgent {
  return {
    key: agentKey,
    launch: {
      request_id: '00000000-0000-4000-8000-000000000001',
      name: 'reviewer',
      provider: 'claude',
      state: 'ready',
      desired_state: 'running',
      revision: 4,
      agent_id: 'agent',
      error: null,
      error_code: null,
      sleeping: false,
    },
    sessions: null,
    problem: null,
  };
}

function sessions(sessionIds: string[]) {
  return {
    sessions: sessionIds.map(
      (sessionId) => ({ sessionId, status: 'ready', connectivity: 'online' }) as never
    ),
    problem: null,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  navigate.mockReset();
  sdkHost.cloudAgents.mockReset();
  sdkHost.cloudSessions.mockReset();
  sdkHost.cloudSessionOperation.mockReset();
  cloudOperationAttempts.settle(startAttemptKey(agentKey));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
}

async function render(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const Panel = serverAgentsView.MainPanel;
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Panel />
      </QueryClientProvider>
    )
  );
  await settle();
  return container;
}

function button(el: HTMLElement, name: RegExp): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

it('shows a start in progress and does not offer a second one', async () => {
  let reply: (outcome: unknown) => void = () => {};
  sdkHost.cloudSessionOperation.mockImplementation(
    () => new Promise((resolve) => (reply = resolve))
  );
  sdkHost.cloudAgents.mockResolvedValue([agent()]);
  const el = await render();
  await act(async () => button(el, /new session/i)!.click());

  const starting = button(el, /starting session/i);
  expect(starting?.disabled).toBe(true);
  expect(button(el, /new session/i)).toBeUndefined();

  await act(async () => reply({ state: 'applied' }));
  expect(navigate).toHaveBeenCalledWith('cloudSession', expect.objectContaining({ agentKey }));
});

it('shows a lost reply as not yet known, and asks again for the same session', async () => {
  sdkHost.cloudSessionOperation.mockResolvedValueOnce({ state: 'unknown', message: 'lost' });
  sdkHost.cloudSessionOperation.mockResolvedValueOnce({ state: 'applied' });
  sdkHost.cloudAgents.mockResolvedValue([agent()]);
  sdkHost.cloudSessions.mockResolvedValue(sessions([]));
  const el = await render();
  await act(async () => button(el, /new session/i)!.click());
  await settle();

  expect(el.querySelector('[role="status"]')?.textContent).toMatch(/not yet known/i);
  expect(el.querySelector('[role="alert"]')).toBeNull();
  await act(async () => button(el, /check again/i)!.click());
  const [first, second] = sdkHost.cloudSessionOperation.mock.calls;
  expect(second).toEqual(first);
  expect(navigate).toHaveBeenCalledWith(
    'cloudSession',
    expect.objectContaining({ agentKey, sessionId: first[1] })
  );
});

it('offers Open once the unconfirmed session exists', async () => {
  let started = '';
  sdkHost.cloudSessionOperation.mockImplementation(async (_key: string, sessionId: string) => {
    started = sessionId;
    return { state: 'unknown', message: 'lost' };
  });
  sdkHost.cloudAgents.mockResolvedValue([agent()]);
  sdkHost.cloudSessions.mockResolvedValue(sessions([]));
  const el = await render();
  await act(async () => button(el, /new session/i)!.click());
  await settle();

  sdkHost.cloudSessions.mockResolvedValue(sessions([started]));
  await act(async () => root!.unmount());
  const remounted = await render();
  const open = button(remounted, /^open$/i);
  expect(open).toBeDefined();
  await act(async () => open!.click());
  expect(navigate).toHaveBeenCalledWith(
    'cloudSession',
    expect.objectContaining({ agentKey, sessionId: started })
  );
  expect(sdkHost.cloudSessionOperation).toHaveBeenCalledTimes(1);
});
