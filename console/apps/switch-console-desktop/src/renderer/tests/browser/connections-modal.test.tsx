/**
 * Connections open from a server's Your Agents page at any time, not only from
 * the setup wizard. The button is offered on a server with service
 * connections, which any agent can be granted, or with cloud machines; the
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

const modalHost = vi.hoisted(() => ({
  show: (_id: string, _args: unknown): void => {
    throw new Error('No modal host is mounted.');
  },
}));
const switchServers = vi.hoisted(() => ({
  cloudMachines: vi.fn(),
  getConnectionCatalog: vi.fn(),
  getGitHubConnection: vi.fn(),
  startServiceConnection: vi.fn(),
  getServiceFlow: vi.fn(),
  confirmServiceConnection: vi.fn(),
  connectServiceWithKey: vi.fn(),
  disconnectService: vi.fn(),
}));
const openExternalUrl = vi.hoisted(() => vi.fn());

const serverFlags = vi.hoisted(() => ({ service_connections: false }));
const featureFlags = vi.hoisted(() => ({
  get: vi.fn(async () => ({ success: true, data: { flags: { ...serverFlags } } })),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers, featureFlags },
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
  switchServersStore: { servers: [], statusFor: () => null, isConnected: () => false },
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: () => {} }),
  useParams: () => ({ params: { serverId: 'server' } }),
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: (id: string) => (args: unknown) => modalHost.show(id, args),
  useModalContext: () => ({ setCloseGuard: () => {} }),
}));

vi.mock('@renderer/lib/open-external', () => ({ openExternalUrl }));

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
    connectable: enabled,
    status,
    unavailable_reason: null,
    pass_through: false,
    token_lifetime: null,
    loopback_ports: null,
    key: null,
    external_identity: null,
  };
}

const CATALOG = [
  entry('github', 'GitHub', true, 'not_connected'),
  entry('linear', 'Linear', false, 'coming_soon'),
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  switchServers.cloudMachines.mockReset();
  switchServers.getConnectionCatalog.mockReset();
  switchServers.getGitHubConnection.mockReset();
  serverFlags.service_connections = true;
  switchServers.connectServiceWithKey.mockReset();
  switchServers.disconnectService.mockReset();
  openExternalUrl.mockReset().mockResolvedValue(true);
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

it('offers no Connections for cloud machines alone, without service connections', async () => {
  serverFlags.service_connections = false;
  switchServers.cloudMachines.mockResolvedValue([]);
  await render();

  await vi.waitFor(() => expect(featureFlags.get).toHaveBeenCalledWith('server'));
  await act(async () => {});
  expect(button(/^connections$/i, container!)).toBeUndefined();
});

it('offers Connections on a server with service connections and no cloud machine', async () => {
  switchServers.cloudMachines.mockResolvedValue(null);
  serverFlags.service_connections = true;
  await render();

  await vi.waitFor(() => expect(button(/^connections$/i, container!)).toBeDefined());
  expect(featureFlags.get).toHaveBeenCalledWith('server');
});

it('offers no Connections without service connections or cloud machines', async () => {
  serverFlags.service_connections = false;
  switchServers.cloudMachines.mockResolvedValue(null);
  await render();

  await vi.waitFor(() => expect(switchServers.cloudMachines).toHaveBeenCalled());
  await vi.waitFor(() => expect(featureFlags.get).toHaveBeenCalled());
  await act(async () => {});
  expect(button(/^connections$/i, container!)).toBeUndefined();
});

it('disables a service the server cannot connect, saying why', async () => {
  serverFlags.service_connections = true;
  switchServers.cloudMachines.mockResolvedValue(null);
  switchServers.getConnectionCatalog.mockResolvedValue([
    {
      ...entry('github', 'GitHub', true, 'not_connected'),
      connectable: false,
      unavailable_reason: 'GitHub is not set up on this server.',
    },
  ]);
  await render();
  const modal = await openConnections();

  await vi.waitFor(() => expect(button(/GitHub/, modal)).toBeDefined());
  expect(button(/GitHub/, modal)?.disabled).toBe(true);
  expect(button(/GitHub/, modal)?.textContent).toMatch(/not set up on this server/);
});

it('shows the server’s connection grid', async () => {
  switchServers.cloudMachines.mockResolvedValue([]);
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
  switchServers.cloudMachines.mockResolvedValue([]);
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
  switchServers.cloudMachines.mockResolvedValue([]);
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

it("says when an organization's single sign-on hides its installation", async () => {
  switchServers.cloudMachines.mockResolvedValue([]);
  switchServers.getConnectionCatalog.mockResolvedValue(CATALOG);
  switchServers.getGitHubConnection.mockResolvedValue({
    status: 'connected',
    login: 'example-user',
    install_url: 'https://github.com/apps/example/installations/new',
    installations: [],
    sso_hidden_organizations: [21955855],
  });
  await render();
  const modal = await openConnections();
  await vi.waitFor(() => expect(button(/GitHub/, modal)?.disabled).toBe(false));

  await act(async () => button(/GitHub/, modal)!.click());
  await vi.waitFor(() =>
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toMatch(
      /single sign-on hides its installation/
    )
  );
});

it('connects any connectable service through the generic sign-in', async () => {
  switchServers.cloudMachines.mockResolvedValue([]);
  switchServers.getConnectionCatalog.mockResolvedValue([
    ...CATALOG,
    entry('example', 'Example', true, 'not_connected'),
  ]);
  switchServers.startServiceConnection.mockResolvedValue('flow-1');
  switchServers.getServiceFlow.mockResolvedValue({
    status: 'ready',
    account: 'ada@example.test',
    error: null,
  });
  switchServers.confirmServiceConnection.mockResolvedValue({ warning: null });
  await render();
  const modal = await openConnections();
  await vi.waitFor(() => expect(button(/Example/, modal)?.disabled).toBe(false));

  await act(async () => button(/Example/, modal)!.click());
  await vi.waitFor(() => expect(button(/^connect example/i, dialog()!)).toBeDefined());
  expect(switchServers.getGitHubConnection).not.toHaveBeenCalled();
  await act(async () => button(/^connect example/i, dialog()!)!.click());
  expect(switchServers.startServiceConnection).toHaveBeenCalledWith('server', 'example');

  await vi.waitFor(() => expect(dialog()!.textContent).toMatch(/Signed in as ada@example\.test/));
  await act(async () => button(/^connect ada@example\.test/i, dialog()!)!.click());
  expect(switchServers.confirmServiceConnection).toHaveBeenCalledWith(
    'server',
    'example',
    'flow-1'
  );
  await vi.waitFor(() => expect(dialog()!.textContent).toMatch(/Example connected/));
  expect(button(/^disconnect$/i, dialog()!)).toBeDefined();
});

const API_KEY = 'synthetic-datadog-api-key';
const APP_KEY = 'synthetic-datadog-application-key';

/** A service connected with a key, as the catalog describes Datadog's. */
function keyed(status: ConnectionCatalogEntry['status'] = 'not_connected'): ConnectionCatalogEntry {
  return {
    ...entry('datadog', 'Datadog', true, status),
    category: 'Observability',
    auth_type: 'api_key',
    pass_through: true,
    token_lifetime: 3600,
    external_identity: status === 'connected' ? 'Datadog key · datadoghq.eu' : null,
    key: {
      fields: [
        {
          name: 'api_key',
          label: 'API key',
          secret: true,
          help: 'Organization Settings, API Keys.',
          choices: null,
        },
        {
          name: 'application_key',
          label: 'Application key',
          secret: true,
          help: 'Personal Settings, Application Keys.',
          choices: null,
        },
        {
          name: 'site',
          label: 'Datadog site',
          secret: false,
          help: 'The address you open Datadog at.',
          choices: ['datadoghq.com', 'datadoghq.eu'],
        },
      ],
      help_url: 'https://docs.datadoghq.com/account_management/api-app-keys/',
    },
  };
}

async function openKeyStep(status: ConnectionCatalogEntry['status'] = 'not_connected') {
  switchServers.cloudMachines.mockResolvedValue([]);
  switchServers.getConnectionCatalog.mockResolvedValue([...CATALOG, keyed(status)]);
  await render();
  const modal = await openConnections();
  await vi.waitFor(() => expect(button(/Datadog/, modal)?.disabled).toBe(false));
  await act(async () => button(/Datadog/, modal)!.click());
  await vi.waitFor(() =>
    expect(dialog()!.textContent).toMatch(/Connect Datadog|Datadog connected/)
  );
  return dialog()!;
}

function input(within: ParentNode, label: string): HTMLInputElement {
  const id = [...within.querySelectorAll('label')].find((l) => l.textContent === label)!.htmlFor;
  return within.querySelector<HTMLInputElement>(`#${id}`)!;
}

async function type(target: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pick(within: ParentNode, label: string, choice: string) {
  await act(async () => within.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click());
  await vi.waitFor(() =>
    expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0)
  );
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent?.trim() === choice
  )!;
  await act(async () => option.click());
}

async function fillKey(step: HTMLElement) {
  await type(input(step, 'API key'), API_KEY);
  await type(input(step, 'Application key'), APP_KEY);
  await pick(step, 'Datadog site', 'datadoghq.eu');
}

it('opens a key service in a form built from its catalog entry, not the sign-in', async () => {
  const step = await openKeyStep();

  expect(step.textContent).toMatch(/Connect Datadog/);
  expect(input(step, 'API key').type).toBe('password');
  expect(input(step, 'Application key').type).toBe('password');
  expect(step.querySelector('[aria-label="Datadog site"]')).not.toBeNull();
  expect(step.textContent).toContain('Organization Settings, API Keys.');
  expect(step.textContent).toContain('The address you open Datadog at.');
  expect(step.textContent).toContain(
    "Switch checks the key with Datadog, stores it encrypted, and never shows it again. The agent can do whatever this key allows. Keys don't expire; disconnecting removes the key from Switch but can't revoke it at Datadog — revoke it there too."
  );
  expect(switchServers.startServiceConnection).not.toHaveBeenCalled();
  await act(async () => button(/How to make a Datadog key/, step)!.click());
  expect(openExternalUrl).toHaveBeenCalledWith(
    'https://docs.datadoghq.com/account_management/api-app-keys/',
    expect.any(String)
  );
  expect(button(/^connect datadog$/i, step)?.disabled).toBe(true);
});

it('connects with the fields typed and picked, and shows whose key it is', async () => {
  switchServers.connectServiceWithKey.mockResolvedValue({
    warning: null,
    external_identity: 'Datadog key · datadoghq.eu',
  });
  switchServers.disconnectService.mockResolvedValue({
    warning: 'Switch has forgotten the Datadog key but cannot revoke it.',
  });
  const step = await openKeyStep();
  await fillKey(step);

  await vi.waitFor(() => expect(button(/^connect datadog$/i, step)?.disabled).toBe(false));
  await act(async () => button(/^connect datadog$/i, step)!.click());
  expect(switchServers.connectServiceWithKey).toHaveBeenCalledWith('server', 'datadog', {
    api_key: API_KEY,
    application_key: APP_KEY,
    site: 'datadoghq.eu',
  });
  await vi.waitFor(() => expect(dialog()!.textContent).toMatch(/Datadog connected/));
  expect(dialog()!.textContent).toContain('Connected with Datadog key · datadoghq.eu');
  expect(dialog()!.innerHTML).not.toContain(API_KEY);
  expect(dialog()!.innerHTML).not.toContain(APP_KEY);

  await act(async () => button(/^replace key$/i, dialog()!)!.click());
  expect(input(dialog()!, 'API key').value).toBe('');
  expect(input(dialog()!, 'Application key').value).toBe('');

  await act(async () => button(/^disconnect$/i, dialog()!)!.click());
  expect(switchServers.disconnectService).toHaveBeenCalledWith('server', 'datadog');
  await vi.waitFor(() =>
    expect(dialog()!.querySelector('[role="status"]')?.textContent).toBe(
      'Switch has forgotten the Datadog key but cannot revoke it.'
    )
  );
  expect(dialog()!.textContent).toMatch(/Connect Datadog/);
});

it('shows Switch’s refusal of a key, and clears the keys typed', async () => {
  switchServers.connectServiceWithKey.mockRejectedValue(
    new RpcError(
      serializeRpcError(
        Object.assign(new Error('Switch gateway returned 422'), {
          name: 'GatewayError',
          kind: 'http',
          status: 422,
          detail: 'Datadog refused the key (HTTP 403). Check that it is right.',
        })
      )
    )
  );
  const step = await openKeyStep();
  await fillKey(step);
  await act(async () => button(/^connect datadog$/i, step)!.click());

  await vi.waitFor(() =>
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain(
      'Datadog refused the key (HTTP 403). Check that it is right.'
    )
  );
  expect(input(dialog()!, 'API key').value).toBe('');
  expect(input(dialog()!, 'Application key').value).toBe('');
  expect(dialog()!.querySelector('[aria-label="Datadog site"]')?.textContent).toContain(
    'datadoghq.eu'
  );
  expect(dialog()!.textContent).toMatch(/Connect Datadog/);
});

it('shows a connected key service as connected, with whose key it is', async () => {
  const step = await openKeyStep('connected');
  expect(step.textContent).toMatch(/Datadog connected/);
  expect(step.textContent).toContain('Connected with Datadog key · datadoghq.eu');
  expect(button(/^disconnect$/i, step)).toBeDefined();
  expect(step.querySelector('[aria-label="Datadog key"]')).toBeNull();
});
