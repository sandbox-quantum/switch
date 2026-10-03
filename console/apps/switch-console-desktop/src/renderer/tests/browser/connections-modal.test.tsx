/**
 * Connections open from a server's Your Agents page at any time, not only from
 * the setup wizard. The button is offered on a server with cloud agents; the
 * modal shows the server's catalog, says so when the catalog cannot be read
 * (an older server has no catalog endpoint) rather than showing an empty one,
 * and opens the GitHub step in place, with a way back to the grid.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { RpcError, serializeRpcError } from '@shared/lib/ipc/rpc-error';

const sdkHost = vi.hoisted(() => ({
  cloudAgents: vi.fn(),
  cloudMachines: vi.fn(),
}));
const modalHost = vi.hoisted(() => ({
  show: (_id: string, _args: unknown): void => {
    throw new Error('No modal host is mounted.');
  },
}));
const switchServers = vi.hoisted(() => ({
  getConnectionCatalog: vi.fn(),
  getGitHubConnection: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { sdkHost, switchServers },
}));

vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: { agentsOnServer: () => [] },
}));

vi.mock('@renderer/features/sidebar/sidebar-tree-data', () => ({
  refreshSidebarRoomState: async () => {},
  refreshSidebarRoomStateAfterOnboarding: async () => {},
}));

vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: { workspacesNotSignedIn: [], roomNameById: () => null },
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { servers: [], statusFor: () => null },
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: () => {} }),
  useParams: () => ({ params: { serverId: 'server' } }),
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: (id: string) => (args: unknown) => modalHost.show(id, args),
  useModalContext: () => ({ setCloseGuard: () => {} }),
}));

vi.mock('@renderer/lib/stores/use-remote-agents', () => ({
  useAgentIconUrl: () => null,
}));

import { ConnectionsModal } from '@renderer/features/switch-servers/ConnectionsModal';
import { serverAgentsView } from '@renderer/features/switch-servers/server-agents-view';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';

/** Stands in for the modal renderer: shows the Connections modal once the page asks for it. */
function ModalHost() {
  const [shown, setShown] = useState<{ id: string; args: { serverId: string } } | null>(null);
  useEffect(() => {
    modalHost.show = (id, args) => setShown({ id, args: args as { serverId: string } });
  }, []);
  if (!shown) return null;
  expect(shown.id).toBe('connectionsModal');
  return (
    <Dialog open>
      <DialogContent>
        <ConnectionsModal
          serverId={shown.args.serverId}
          onClose={() => setShown(null)}
          onSuccess={() => {}}
        />
      </DialogContent>
    </Dialog>
  );
}

function entry(
  slug: string,
  name: string,
  enabled: boolean,
  status: ConnectionCatalogEntry['status']
): ConnectionCatalogEntry {
  return {
    slug,
    name,
    category: 'Development',
    description: `${name} access`,
    enabled,
    auth_type: 'oauth',
    status,
  };
}

const CATALOG = [
  entry('github', 'GitHub', true, 'not_connected'),
  entry('linear', 'Linear', false, 'coming_soon'),
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  sdkHost.cloudAgents.mockReset();
  sdkHost.cloudMachines.mockReset();
  sdkHost.cloudMachines.mockResolvedValue(null);
  switchServers.getConnectionCatalog.mockReset();
  switchServers.getGitHubConnection.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const Panel = serverAgentsView.MainPanel;
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Panel />
        <ModalHost />
      </QueryClientProvider>
    )
  );
}

function button(name: RegExp, within: ParentNode = document): HTMLButtonElement | undefined {
  return [...within.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
}

async function openConnections(): Promise<HTMLElement> {
  await vi.waitFor(() => expect(button(/^connections$/i, container!)).toBeDefined());
  await act(async () => button(/^connections$/i, container!)!.click());
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  return dialog()!;
}

it('offers Connections on a server with cloud agents', async () => {
  sdkHost.cloudAgents.mockResolvedValue([]);
  await render();

  await vi.waitFor(() => expect(button(/^connections$/i, container!)).toBeDefined());
});

it('offers no Connections on a server without cloud agents', async () => {
  sdkHost.cloudAgents.mockResolvedValue(null);
  await render();

  await vi.waitFor(() => expect(sdkHost.cloudAgents).toHaveBeenCalled());
  await act(async () => {});
  expect(button(/^connections$/i, container!)).toBeUndefined();
});

it('shows the server’s connection grid', async () => {
  sdkHost.cloudAgents.mockResolvedValue([]);
  switchServers.getConnectionCatalog.mockResolvedValue(CATALOG);
  await render();
  const modal = await openConnections();

  await vi.waitFor(() =>
    expect(modal.querySelector('[role="group"][aria-label="Connections"]')).not.toBeNull()
  );
  expect(switchServers.getConnectionCatalog).toHaveBeenCalledWith('server');
  expect(button(/GitHub/, modal)?.disabled).toBe(false);
  expect(button(/Linear/, modal)?.disabled).toBe(true);
  expect(button(/Linear/, modal)?.textContent).toMatch(/Coming soon/);
});

it('shows the real error when the catalog cannot be read', async () => {
  sdkHost.cloudAgents.mockResolvedValue([]);
  switchServers.getConnectionCatalog.mockRejectedValue(
    new RpcError(
      serializeRpcError(
        Object.assign(new Error('Switch gateway returned 404'), {
          name: 'GatewayError',
          kind: 'http',
          status: 404,
          detail: 'Not Found',
        })
      )
    )
  );
  await render();
  const modal = await openConnections();

  await vi.waitFor(() =>
    expect(modal.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not load connections. (HTTP 404: Not Found)'
    )
  );
  expect(modal.querySelector('[role="group"][aria-label="Connections"]')).toBeNull();
  expect(button(/^retry$/i, modal)).toBeDefined();
});

it('opens the GitHub step from the grid and returns to it', async () => {
  sdkHost.cloudAgents.mockResolvedValue([]);
  switchServers.getConnectionCatalog.mockResolvedValue(CATALOG);
  switchServers.getGitHubConnection.mockResolvedValue({
    status: 'not_connected',
    install_url: 'https://github.com/apps/example/installations/new',
  });
  await render();
  const modal = await openConnections();
  await vi.waitFor(() => expect(button(/GitHub/, modal)?.disabled).toBe(false));

  await act(async () => button(/GitHub/, modal)!.click());
  await vi.waitFor(() => expect(button(/^connect github\s*$/i, dialog()!)).toBeDefined());
  expect(switchServers.getGitHubConnection).toHaveBeenCalledWith('server');
  expect(button(/set up later/i, dialog()!)).toBeUndefined();
  expect(button(/continue to agent/i, dialog()!)).toBeUndefined();

  await act(async () => button(/^back$/i, dialog()!)!.click());
  await vi.waitFor(() =>
    expect(dialog()!.querySelector('[role="group"][aria-label="Connections"]')).not.toBeNull()
  );
  expect(switchServers.getConnectionCatalog).toHaveBeenCalledTimes(2);
});
