/**
 * The Add server dialog opened on a signed-in Switch Cloud account's setup, as
 * the first-run pages and the checklist open it: straight onto choosing
 * providers, with no chooser or sign-in before it, and reported as the path it
 * belongs to.
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

const report = vi.hoisted(() => vi.fn());
const getClaudeConnection = vi.hoisted(() =>
  vi.fn(async () => ({ status: 'connected', kind: 'api-key', verified_at: '2026-01-01T00:00:00Z' }))
);

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers: { getClaudeConnection, switchCloud: () => Promise.resolve(null) } },
}));
vi.mock('@renderer/lib/telemetry/report', () => ({ report }));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: vi.fn() }),
}));
vi.mock('@renderer/lib/components/agent-icon', () => ({ AgentIcon: () => null }));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { setActive: vi.fn(), isConnected: () => true },
}));

import { AddServerModal } from '@renderer/features/switch-servers/AddServerModal';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

const CLOUD = {
  id: 'cloud-1',
  name: 'Switch Cloud',
  gatewayUrl: 'https://cloud.example.com',
  apiUrl: 'https://cloud.example.com',
} as SwitchServer;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  report.mockReset();
  getClaudeConnection.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(machineUnavailable: string | null, firstRun: boolean): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Dialog open>
          <DialogContent>
            <AddServerModal
              cloudSetup={{ server: CLOUD, machineUnavailable, firstRun }}
              onSuccess={() => {}}
              onClose={() => {}}
            />
          </DialogContent>
        </Dialog>
      </QueryClientProvider>
    )
  );
  return document.body;
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label
  );
  expect(found, `no ${label} button`).toBeDefined();
  return found!;
}

it('opens on choosing providers, then connects the ones chosen', async () => {
  const el = await render(null, true);

  expect(el.textContent).toContain('Choose agents to connect');
  expect(el.textContent).not.toContain('Add a Switch server');

  const claude = [...el.querySelectorAll('label')].find((l) =>
    l.textContent?.includes('Claude Code')
  );
  await act(async () => claude!.querySelector<HTMLElement>('[role="checkbox"], button')!.click());
  await act(async () => button(el, 'Continue').click());

  await vi.waitFor(() => expect(el.textContent).toContain('Claude Code connected'));
  expect(getClaudeConnection).toHaveBeenCalledWith('cloud-1');
});

it('reports the steps under the cloud path, as first run when opened from it', async () => {
  await render(null, true);

  expect(report).toHaveBeenCalledWith('add_server_step', {
    step: 'managedReady',
    choice: 'cloud',
    first_run: true,
  });
});

it('says why the cloud machine is not starting', async () => {
  const el = await render('No capacity in your region.', false);

  expect(el.textContent).toContain('Your cloud machine is not starting');
  expect(el.textContent).toContain('No capacity in your region.');
  expect(report).toHaveBeenCalledWith('add_server_step', {
    step: 'managedReady',
    choice: 'cloud',
    first_run: false,
  });
});
