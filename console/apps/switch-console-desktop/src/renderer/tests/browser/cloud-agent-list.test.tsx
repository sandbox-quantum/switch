/**
 * A new cloud session whose start was never confirmed is not shown as a
 * failure: once the session appears, the row offers to open it, and until
 * then it asks again for the same session rather than a new one.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CloudAgent } from '@shared/core/cloud-agents/cloud-agents';

const sdkHost = vi.hoisted(() => ({
  cloudAgents: vi.fn(),
  cloudSessionOperation: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { sdkHost },
}));

vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: { serversNotSignedIn: [], roomNameById: () => null },
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { activeServerId: 'server' },
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate }),
  useParams: () => ({ params: {} }),
}));

vi.mock('@renderer/lib/layout/workspace-slots', () => ({
  useWorkspaceSlots: () => ({ currentView: 'home' }),
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: {
    isGroupExpanded: () => false,
    toggleGroupExpanded: () => {},
    hideProviderMark: true,
  },
}));

import { CloudAgentList } from '@renderer/features/cloud-agents/cloud-agent-list';
import {
  cloudOperationAttempts,
  startAttemptKey,
} from '@renderer/features/cloud-agents/cloud-operation-attempts';

const agentKey = 'cloud:server:launch';

function agent(sessionIds: string[]): CloudAgent {
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
    sessions: sessionIds.map(
      (sessionId) => ({ sessionId, status: 'ready', connectivity: 'online' }) as never
    ),
    problem: null,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  navigate.mockReset();
  sdkHost.cloudSessionOperation.mockReset();
  cloudOperationAttempts.settle(startAttemptKey(agentKey));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <CloudAgentList />
      </QueryClientProvider>
    )
  );
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)));
  return container;
}

function button(el: HTMLElement, name: RegExp): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find(
    (b) => name.test(b.textContent ?? '') || name.test(b.getAttribute('aria-label') ?? '')
  );
}

it('offers Open for an unconfirmed start whose session exists, not an error', async () => {
  let started = '';
  sdkHost.cloudSessionOperation.mockImplementation(async (_key: string, sessionId: string) => {
    started = sessionId;
    return { state: 'unknown', message: 'The server did not confirm the session start.' };
  });
  sdkHost.cloudAgents.mockResolvedValue([agent([])]);
  const el = await render();
  await act(async () => button(el, /new session/i)!.click());
  expect(el.querySelector('[role="alert"]')).toBeNull();
  expect(button(el, /check again/i)).toBeDefined();

  sdkHost.cloudAgents.mockResolvedValue([agent([started])]);
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

it('asks again for the same session from Check again', async () => {
  sdkHost.cloudSessionOperation.mockResolvedValueOnce({ state: 'unknown', message: 'lost' });
  sdkHost.cloudSessionOperation.mockResolvedValueOnce({ state: 'applied' });
  sdkHost.cloudAgents.mockResolvedValue([agent([])]);
  const el = await render();
  await act(async () => button(el, /new session/i)!.click());
  await act(async () => button(el, /check again/i)!.click());
  const [first, second] = sdkHost.cloudSessionOperation.mock.calls;
  expect(second).toEqual(first);
  expect(navigate).toHaveBeenCalledWith(
    'cloudSession',
    expect.objectContaining({ sessionId: first[1] })
  );
});
