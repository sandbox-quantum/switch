/**
 * A cloud session's header says what its launch is doing while the worker
 * cannot be asked: the session's last reported status is stale then, so a
 * sleeping launch must not read as ready.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CloudAgent, CloudSessions } from '@shared/core/cloud-agents/cloud-agents';

const sdkHost = vi.hoisted(() => ({
  cloudAgents: vi.fn(),
  cloudSessions: vi.fn(),
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
  switchRoomsStore: { workspacesNotSignedIn: [], roomNameById: () => null },
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
      machine_id: null,
      process_state: null,
      process_restarts: 0,
      oom_kills: 0,
    },
    machine: null,
    sessions: null,
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

async function headerStatus(
  cloudAgent: CloudAgent,
  relayed: CloudSessions,
  opened: typeof snapshot
): Promise<string | null | undefined> {
  sdkHost.cloudAgents.mockResolvedValue([cloudAgent]);
  sdkHost.cloudSessions.mockResolvedValue(relayed);
  sdkHost.transcriptOpen.mockResolvedValue(opened);
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
  expect(await headerStatus(agent({}), { sessions: [], problem: null }, snapshot)).toBe('ready');
});

it('reads sleeping, not ready, while the launch is asleep', async () => {
  const status = await headerStatus(
    agent({
      launch: { ...agent({}).launch, sleeping: true, state: 'stopped', desired_state: 'running' },
      sessions: null,
      problem: {
        code: 'worker_sleeping',
        message: 'The cloud worker is asleep.',
        wakeAvailable: true,
      },
    }),
    { sessions: [], problem: null },
    snapshot
  );
  expect(status).toBe('sleeping');
});

it('reads unreachable when the relay refuses the worker', async () => {
  const status = await headerStatus(
    agent({}),
    {
      sessions: null,
      problem: { code: 'worker_busy', message: 'Too many requests.', wakeAvailable: false },
    },
    snapshot
  );
  expect(status).toBe('unreachable');
});

function offline(status: string) {
  return { ...snapshot, session: { ...snapshot.session, status, connectivity: 'offline' } };
}

it('says nothing about a session the next message restarts', async () => {
  const status = await headerStatus(agent({}), { sessions: [], problem: null }, offline('ready'));
  expect(status).toBeUndefined();
});

it('still says a stopped session is stopped', async () => {
  const status = await headerStatus(agent({}), { sessions: [], problem: null }, offline('stopped'));
  expect(status).toBe('stopped');
});

it('opens a session on a sleeping machine whose worker cannot be read, and wakes it on send', async () => {
  const asleep = agent({
    launch: { ...agent({}).launch, sleeping: true, state: 'stopped' },
    problem: {
      code: 'worker_sleeping',
      message: 'The cloud machine is asleep.',
      wakeAvailable: true,
    },
  });
  sdkHost.cloudWake.mockResolvedValue(undefined);
  sdkHost.transcriptOpen.mockRejectedValue(new Error('The cloud machine is asleep.'));
  sdkHost.cloudAgents.mockResolvedValue([asleep]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const Panel = cloudSessionView.MainPanel;
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <SessionHeaderSlotsProvider>
          <Panel />
        </SessionHeaderSlotsProvider>
      </QueryClientProvider>
    )
  );
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 50)));
  expect(container.textContent).toContain('Send a message to wake it.');

  const input = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message the agent"]'
  )!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, 'good morning');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const send = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Send')!;
  expect(send.disabled).toBe(false);
  await act(async () => send.click());
  expect(sdkHost.cloudWake).toHaveBeenCalledWith('cloud:server:launch');
  expect(container.textContent).toContain('Waking… about 1–2 min.');
});
