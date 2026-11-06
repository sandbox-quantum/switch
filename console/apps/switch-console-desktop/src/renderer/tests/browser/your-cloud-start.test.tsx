/**
 * Hosted agents v2, Your cloud's card: a box that was put away (retained) or
 * stopped shows its real state with Start, never "Ready" from an old report,
 * and Start asks Switch for the box (ensure), which wakes a retained box that
 * lifecycle start can't. A paused box offers no Start.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';

const switchServers = vi.hoisted(() => ({
  ensureCloudMachine: vi.fn(),
  cloudMachineLifecycle: vi.fn(),
}));
const managedAgents = vi.hoisted(() => ({
  loginSources: vi.fn(async () => []),
  repairCloud: vi.fn(),
  resealAfterRepair: vi.fn(),
  machines: vi.fn(async () => []),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: {
    switchServers,
    managedAgents,
    userChanges: { watch: async () => false, unwatch: async () => {} },
    // The card's Your cloud files button asks for the server's flags (the file
    // explorer, merged in). Every flag off keeps that button hidden, as these
    // tests expect.
    featureFlags: {
      get: async (serverId: string) => ({
        success: true,
        data: {
          serverId,
          flags: (await import('@shared/core/feature-flags/feature-flags')).allFeatureFlagsOff(),
          fetchedAt: 1,
          error: null,
        },
      }),
      refresh: async () => ({ success: true, data: undefined }),
    },
  },
}));

import { CloudMachineCard } from '@renderer/features/cloud-agents/cloud-machine-card';

function box(over: Partial<CloudMachine> = {}): CloudMachine {
  return {
    machine_id: 'm1',
    state: 'retained',
    desired_state: 'retained',
    stop_reason: 'idle',
    sleeping: false,
    revision: 5,
    instance_type: null,
    error: null,
    error_code: null,
    retain_until: null,
    heartbeat_at: '2026-11-04T07:52:00Z',
    disk: null,
    memory: null,
    agents: [],
    controller_id: 'c1',
    backend: 'box',
    // The last report still says there is plenty of room: it must not read as "Ready".
    room: { used_bytes: 1, total_bytes: 8 },
    awake: { running: 0, max: 12 },
    ai_calls_today: null,
    ...over,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  switchServers.ensureCloudMachine.mockResolvedValue({ machine_id: 'm1' });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(machine: CloudMachine): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <CloudMachineCard machine={machine} serverId="server" box />
      </QueryClientProvider>
    )
  );
  return container;
}

const startButton = (el: HTMLElement) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === 'Start') ?? null;

it('a retained box reads Stopped, never Ready or room figures, and Start calls ensure', async () => {
  const el = await render(box());
  expect(el.textContent).toContain('Stopped');
  expect(el.textContent).not.toContain('Ready');
  expect(el.textContent).not.toContain('awake');
  expect(el.querySelector('[data-capacity]')).toBeNull();
  await act(async () => startButton(el)!.click());
  expect(switchServers.ensureCloudMachine).toHaveBeenCalledWith('server');
  expect(switchServers.cloudMachineLifecycle).not.toHaveBeenCalled();
});

it('a box its owner stopped is started by lifecycle start, never ensure', async () => {
  switchServers.cloudMachineLifecycle.mockResolvedValue({});
  const el = await render(
    box({ state: 'stopped', desired_state: 'stopped', stop_reason: 'owner', agents: ['a1'] })
  );
  expect(el.textContent).toContain('Stopped');
  expect(el.textContent).not.toContain('Ready');
  await act(async () => startButton(el)!.click());
  expect(switchServers.cloudMachineLifecycle).toHaveBeenCalledWith('server', 'm1', 'start', 5);
  expect(switchServers.ensureCloudMachine).not.toHaveBeenCalled();
});

it('a resting box with agents offers Wake, which calls ensure', async () => {
  const el = await render(
    box({ state: 'stopped', desired_state: 'stopped', sleeping: true, agents: ['a1'] })
  );
  expect(el.textContent).toContain(
    'Your cloud is resting to save resources. It wakes in about a minute when you message an agent or press Wake it.'
  );
  const wake = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Wake');
  await act(async () => wake!.click());
  expect(switchServers.ensureCloudMachine).toHaveBeenCalledWith('server');
  expect(switchServers.cloudMachineLifecycle).not.toHaveBeenCalled();
});

it('a box that is starting reads Starting… with no Start', async () => {
  const el = await render(box({ state: 'provisioning', desired_state: 'running' }));
  expect(el.textContent).toContain('Starting…');
  expect(startButton(el)).toBeNull();
});

it('a paused box offers no Start, even when retained', async () => {
  const el = await render(box({ stop_reason: 'paused' }));
  expect(el.textContent).toContain('Paused by Switch');
  expect(startButton(el)).toBeNull();
});

it('a ready box shows its figures and no Start, as before', async () => {
  const el = await render(box({ state: 'ready', desired_state: 'running', stop_reason: null }));
  expect(el.textContent).toContain('Ready');
  expect(startButton(el)).toBeNull();
});

it('Start shows Switch’s refusal on the card', async () => {
  switchServers.ensureCloudMachine.mockRejectedValue(new Error('No room on the shared cloud.'));
  const el = await render(box());
  await act(async () => startButton(el)!.click());
  await vi.waitFor(() => expect(el.textContent).toContain('No room on the shared cloud.'));
});
