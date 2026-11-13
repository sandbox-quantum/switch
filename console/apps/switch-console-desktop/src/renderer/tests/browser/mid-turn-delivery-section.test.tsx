/**
 * The agent's "steer messages sent while it works" setting in Switch Console:
 * it reads the server's value, says how a steered message is read (Claude
 * Code's timing included), and saves the other value when toggled.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const workspaces = vi.hoisted(() => ({
  listAgents: vi.fn(),
  updateMidTurnDelivery: vi.fn(),
}));

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({ rpc: { workspaces } }));

import { MidTurnDeliveryRow } from '@renderer/features/locations/components/settings-view/sections/mid-turn-delivery-section';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

async function render(midTurnDelivery: 'steer' | 'queue' | undefined) {
  workspaces.listAgents.mockResolvedValue([{ id: 'agent-1', midTurnDelivery }]);
  workspaces.updateMidTurnDelivery.mockResolvedValue({ id: 'agent-1' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MidTurnDeliveryRow workspaceId="ws-1" agentId="agent-1" />
      </QueryClientProvider>
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it('shows the setting on, and saves "queue" when it is turned off', async () => {
  await render('steer');
  const toggle = host.querySelector('[role="switch"]') as HTMLButtonElement;
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(host.textContent).toContain('Steer messages sent while it works');
  expect(host.textContent).toContain('Claude Code after the tool call or answer in progress');

  await act(async () => toggle.click());

  expect(workspaces.updateMidTurnDelivery).toHaveBeenCalledWith({
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    mode: 'queue',
  });
});

it('is not shown for a server that predates the setting', async () => {
  await render(undefined);
  expect(host.querySelector('[role="switch"]')).toBeNull();
});
