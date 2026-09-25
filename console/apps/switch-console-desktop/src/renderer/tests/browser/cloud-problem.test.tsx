/**
 * A cloud agent whose worker cannot be asked says why: a sleeping launch reads
 * as asleep and offers a wake, and any other relay refusal is an alert that
 * names its code, with no wake to press.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CloudLaunch, CloudRelayProblem } from '@shared/core/cloud-agents/cloud-agents';

const cloudWake = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: { sdkHost: { cloudWake } },
}));

import { CloudProblem } from '@renderer/features/cloud-agents/cloud-problem';

const launch: CloudLaunch = {
  request_id: '00000000-0000-4000-8000-000000000001',
  name: 'reviewer',
  provider: 'claude',
  state: 'stopped',
  desired_state: 'stopped',
  revision: 4,
  agent_id: 'agent',
  error: null,
  error_code: null,
  sleeping: true,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  cloudWake.mockReset();
  cloudWake.mockResolvedValue({ ...launch, sleeping: false, state: 'queued' });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(problem: CloudRelayProblem, state = launch): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <CloudProblem agentKey="cloud:server:launch" launch={state} problem={problem} compact />
      </QueryClientProvider>
    )
  );
  return container;
}

function wakeButton(el: HTMLElement): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find((b) => /wake/i.test(b.textContent ?? ''));
}

it('reads a sleeping launch as asleep and wakes it', async () => {
  const el = await render({
    code: 'worker_sleeping',
    message: 'The cloud worker is asleep.',
    wakeAvailable: true,
  });
  expect(el.querySelector('[role="status"]')?.textContent).toContain('asleep');
  expect(el.querySelector('[role="alert"]')).toBeNull();
  await act(async () => wakeButton(el)!.click());
  expect(cloudWake).toHaveBeenCalledWith('cloud:server:launch');
});

it('offers no second wake while the launch is already starting', async () => {
  const el = await render(
    { code: 'worker_sleeping', message: 'The cloud worker is asleep.', wakeAvailable: true },
    { ...launch, sleeping: false, state: 'queued', desired_state: 'running' }
  );
  expect(wakeButton(el)).toBeUndefined();
});

it('shows any other refusal as an alert with its code', async () => {
  const el = await render({
    code: 'worker_busy',
    message: 'The worker has too many requests in flight.',
    wakeAvailable: false,
  });
  const alert = el.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('busy');
  expect(alert?.textContent).toContain('too many requests');
  expect(alert?.textContent).toContain('(worker_busy)');
  expect(wakeButton(el)).toBeUndefined();
});

it('says what failed when a wake is refused', async () => {
  cloudWake.mockRejectedValueOnce(new Error('The worker changed.'));
  const el = await render({
    code: 'worker_sleeping',
    message: 'The cloud worker is asleep.',
    wakeAvailable: true,
  });
  await act(async () => wakeButton(el)!.click());
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
  expect(el.textContent).toContain('Could not wake it');
  expect(el.textContent).toContain('The worker changed.');
});
