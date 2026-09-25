/**
 * A cloud session's header says what its launch is doing while the worker
 * cannot be asked: the session's last reported status is stale then, so a
 * sleeping launch must not read as ready.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CloudAgent } from '@shared/core/cloud-agents/cloud-agents';

const sdkHost = vi.hoisted(() => ({
  cloudAgents: vi.fn(),
  cloudWake: vi.fn(),
  transcriptOpen: vi.fn(),
  transcriptClose: vi.fn(),
}));

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

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({
    params: { agentKey: 'cloud:server:launch', sessionId: 'session-demo', name: 'reviewer' },
  }),
}));

import { cloudSessionView } from '@renderer/features/cloud-agents/cloud-session-view';
import {
  SessionHeaderOutlet,
  SessionHeaderSlotsProvider,
} from '@renderer/features/sessions/session-header-slots';

const snapshot = {
  contractVersion: 1,
  throughSequence: 10,
  session: {
    sessionId: 'session-demo',
    agentId: 'agent-demo',
    provider: 'claude',
    hostId: 'host-demo',
    epoch: 'epoch-demo',
    status: 'ready',
    connectivity: 'online',
    capabilities: {
      input: 'queue',
      approvals: true,
      questions: true,
      interrupt: true,
      reset: false,
      compact: false,
      modelChange: false,
      attachmentMimeTypes: [],
    },
    pendingRequestIds: [],
  },
  turns: [],
  items: [],
  requests: [],
  commandStatuses: [],
  nextPageToken: null,
};

function agent(overrides: Partial<CloudAgent>): CloudAgent {
  return {
    key: 'cloud:server:launch',
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
    sessions: [],
    problem: null,
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function headerStatus(cloudAgent: CloudAgent): Promise<string | null | undefined> {
  sdkHost.cloudAgents.mockResolvedValue([cloudAgent]);
  sdkHost.transcriptOpen.mockResolvedValue(snapshot);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const Panel = cloudSessionView.MainPanel;
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <SessionHeaderSlotsProvider>
          <div data-testid="header">
            <SessionHeaderOutlet slot="left" className="" />
          </div>
          <Panel />
        </SessionHeaderSlotsProvider>
      </QueryClientProvider>
    )
  );
  for (let i = 0; i < 20; i++) {
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 10)));
    const text = container.querySelector('[data-testid="header"] [role="status"]')?.textContent;
    if (text && text !== 'loading' && text !== 'offline') return text;
  }
  return container.querySelector('[data-testid="header"] [role="status"]')?.textContent;
}

it('reads ready while the worker answers', async () => {
  expect(await headerStatus(agent({}))).toBe('ready');
});

it('reads sleeping, not ready, while the launch is asleep', async () => {
  const status = await headerStatus(
    agent({
      launch: { ...agent({}).launch, sleeping: true, state: 'stopped', desired_state: 'stopped' },
      sessions: null,
      problem: {
        code: 'worker_sleeping',
        message: 'The cloud worker is asleep.',
        wakeAvailable: true,
      },
    })
  );
  expect(status).toBe('sleeping');
});

it('reads unreachable when the relay refuses the worker', async () => {
  const status = await headerStatus(
    agent({
      sessions: null,
      problem: { code: 'worker_busy', message: 'Too many requests.', wakeAvailable: false },
    })
  );
  expect(status).toBe('unreachable');
});
