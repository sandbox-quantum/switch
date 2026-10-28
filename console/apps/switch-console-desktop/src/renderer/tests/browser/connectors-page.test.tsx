/**
 * The Connectors page of the workspace in scope: its grid shows the
 * workspace's catalog, a service that cannot be used here says so, and a
 * catalog that cannot be read shows the real error with a way to retry
 * rather than an empty grid. A profile shows the truth after a disconnect,
 * made in the page's workspace: the page is re-read before the dialog
 * closes, and a re-read that fails says so on the profile.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { RpcError, serializeRpcError } from '@shared/lib/ipc/rpc-error';

const workspaces = vi.hoisted(() => ({
  getServiceConnections: vi.fn(),
  getConnectionAgents: vi.fn(),
  disconnectService: vi.fn(),
  getGitHubConnection: vi.fn(),
  setServiceGrant: vi.fn(),
  setWorkspaceService: vi.fn(),
}));
const switchServers = vi.hoisted(() => ({
  openGitHubInstallation: vi.fn(),
}));
const modalHost = vi.hoisted(() => ({
  show: (_id: string, _args: unknown): void => {
    throw new Error('No modal host is mounted.');
  },
}));
const featureFlags = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    success: true,
    data: {
      serverId: 'server',
      flags: { service_connections: true },
      fetchedAt: 1,
      error: null,
    },
  })),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: {
    workspaces,
    featureFlags,
    switchServers,
    userChanges: { watch: async () => false, unwatch: async () => {} },
  },
}));

vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: () => 'workspace' },
}));

const admin = vi.hoisted(() => ({ administers: false, operator: false }));

vi.mock('@renderer/features/switch-servers/workspace-admin', () => ({
  administersWorkspaceInScope: () => admin.administers || admin.operator,
  operatesServer: () => admin.operator,
}));

const server = vi.hoisted(() => ({ managed: false }));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    get servers() {
      return [
        { id: 'server', name: 'Dev Server', managed: server.managed, managementKind: 'local' },
      ];
    },
    isConnected: () => true,
    statusFor: () => undefined,
  },
}));

/** Stands in for the app's navigation: a card opens its profile by navigating. */
const navigation = vi.hoisted(() => {
  let params: Record<string, string | undefined> = { serverId: 'server' };
  let view = 'connectors';
  const listeners = new Set<() => void>();
  return {
    params: () => params,
    view: () => view,
    navigate: (to: string, next?: Record<string, string | undefined>) => {
      view = to;
      params = { serverId: 'server', ...next };
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: () => {
      view = 'connectors';
      params = { serverId: 'server' };
    },
  };
});

vi.mock('@renderer/lib/layout/navigation-provider', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useNavigate: () => ({ navigate: navigation.navigate }),
    useParams: () => ({
      params: useSyncExternalStore(navigation.subscribe, navigation.params),
      setParams: () => {},
    }),
  };
});

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: (id: string) => (args: unknown) => modalHost.show(id, args),
  useModalContext: () => ({ setCloseGuard: () => {} }),
}));

import { connectorsView } from '@renderer/features/connectors/connectors-view';
import { DisconnectServiceDialog } from '@renderer/features/connectors/disconnect-dialog';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';

type DisconnectArgs = {
  workspaceId: string;
  connection: ConnectionCatalogEntry;
  onSuccess?: (result: unknown) => void;
};

/** Stands in for the modal renderer: shows the disconnect dialog once the profile asks for it. */
function ModalHost() {
  const [shown, setShown] = useState<{ id: string; args: DisconnectArgs } | null>(null);
  useEffect(() => {
    modalHost.show = (id, args) => setShown({ id, args: args as DisconnectArgs });
  }, []);
  if (shown?.id !== 'disconnectServiceModal') return null;
  const { args } = shown;
  return (
    <Dialog open>
      <DialogContent>
        <DisconnectServiceDialog
          workspaceId={args.workspaceId}
          connection={args.connection}
          onSuccess={(result) => {
            setShown(null);
            args.onSuccess?.(result);
          }}
          onClose={() => setShown(null)}
        />
      </DialogContent>
    </Dialog>
  );
}

function entry(overrides: Partial<ConnectionCatalogEntry>): ConnectionCatalogEntry {
  return {
    slug: 'example',
    name: 'Example',
    category: 'Development',
    description: 'Example access',
    enabled: true,
    auth_type: 'oauth',
    connectable: true,
    status: 'not_connected',
    unavailable_reason: null,
    unavailable_code: null,
    pass_through: true,
    token_lifetime: 3600,
    loopback_ports: null,
    key: null,
    external_identity: null,
    consent: null,
    workspace_enabled: true,
    ...overrides,
  };
}

const CATALOG = [
  entry({ slug: 'atlassian', name: 'Atlassian', status: 'connected', external_identity: 'ada' }),
  entry({ slug: 'example', name: 'Example' }),
  entry({ slug: 'linear', name: 'Linear', enabled: false, status: 'coming_soon' }),
  entry({
    slug: 'github',
    name: 'GitHub',
    connectable: false,
    unavailable_reason: 'GitHub is not set up on this server.',
  }),
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  navigation.reset();
  admin.administers = false;
  admin.operator = false;
  server.managed = false;
  for (const mock of Object.values(workspaces)) mock.mockReset();
  switchServers.openGitHubInstallation.mockReset();
  workspaces.getConnectionAgents.mockResolvedValue([]);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const Panel = connectorsView.MainPanel;
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Panel />
        <ModalHost />
      </QueryClientProvider>
    )
  );
  return container;
}

function button(name: RegExp, within: ParentNode): HTMLButtonElement | undefined {
  return [...within.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

function grid(page: HTMLElement): HTMLElement | null {
  return page.querySelector<HTMLElement>(
    '[role="group"][aria-label="Connectors"]:not([data-slot="toggle-group"])'
  );
}

it("shows the workspace's catalog, what the person has on Yours and everything on Discover", async () => {
  workspaces.getServiceConnections.mockResolvedValue(CATALOG);
  const page = await render();

  await vi.waitFor(() => expect(grid(page)).not.toBeNull());
  expect(workspaces.getServiceConnections).toHaveBeenCalledWith('workspace');
  expect(button(/^Atlassian/, grid(page)!)).toBeDefined();
  expect(button(/^Example/, grid(page)!)).toBeUndefined();
  expect(page.querySelector('[aria-label="Atlassian connected"]')).not.toBeNull();

  await act(async () => page.querySelector<HTMLElement>('button[aria-label="Discover"]')!.click());
  await vi.waitFor(() => expect(button(/^Example/, grid(page)!)).toBeDefined());
  expect(page.querySelector('button[aria-label="Connect Example"]')).not.toBeNull();
  expect(button(/^Linear/, grid(page)!)?.disabled).toBe(true);
  expect(button(/^Linear/, grid(page)!)?.textContent).toMatch(/Coming soon/);
});

it('opens on Discover when nothing is connected yet, and stays on the tab the person picks', async () => {
  const unconnected = CATALOG.map((item) =>
    item.status === 'connected' ? { ...item, status: 'not_connected' as const } : item
  );
  workspaces.getServiceConnections.mockResolvedValue(unconnected);
  const page = await render();

  await vi.waitFor(() => expect(grid(page)).not.toBeNull());
  const pressed = (name: string) =>
    page.querySelector(`button[aria-label="${name}"]`)?.getAttribute('aria-pressed');
  expect(pressed('Discover')).toBe('true');
  expect(button(/^Example/, grid(page)!)).toBeDefined();

  await act(async () => page.querySelector<HTMLElement>('button[aria-label="Yours"]')!.click());
  await vi.waitFor(() => expect(pressed('Yours')).toBe('true'));
  expect(page.textContent).toContain('You have not connected anything yet.');
});

it('marks a service the server cannot use with its reason, without offering to connect it', async () => {
  workspaces.getServiceConnections.mockResolvedValue(CATALOG);
  const page = await render();
  await vi.waitFor(() => expect(grid(page)).not.toBeNull());
  await act(async () => page.querySelector<HTMLElement>('button[aria-label="Discover"]')!.click());

  await vi.waitFor(() => expect(button(/^GitHub/, grid(page)!)).toBeDefined());
  expect(button(/^GitHub/, grid(page)!)!.textContent).toMatch(/Unavailable/);
  expect(button(/^GitHub/, grid(page)!)!.textContent).toContain(
    'GitHub is not set up on this server.'
  );
  expect(page.querySelector('button[aria-label="Connect GitHub"]')).toBeNull();
});

const NOT_SET_UP = entry({
  slug: 'example',
  name: 'Example',
  connectable: false,
  unavailable_reason: 'Example is not set up on this server.',
  unavailable_code: 'app_not_set_up',
});

async function discover(catalog: ConnectionCatalogEntry[]): Promise<HTMLElement> {
  workspaces.getServiceConnections.mockResolvedValue(catalog);
  const page = await render();
  await vi.waitFor(() => expect(grid(page)).not.toBeNull());
  await act(async () => page.querySelector<HTMLElement>('button[aria-label="Discover"]')!.click());
  await vi.waitFor(() => expect(button(/^Example/, grid(page)!)).toBeDefined());
  return page;
}

it("offers the server's operator to set up an app that is not set up, on the card and the profile", async () => {
  admin.operator = true;
  const page = await discover([NOT_SET_UP]);

  expect(button(/^Example/, grid(page)!)!.textContent).toMatch(/Needs setup/);
  const setUp = page.querySelector<HTMLButtonElement>('button[aria-label="Set up Example"]');
  expect(setUp).not.toBeNull();
  await act(async () => setUp!.click());
  expect(navigation.view()).toBe('admin');
  expect(navigation.params()).toEqual({ serverId: 'server', section: 'apps', app: 'example' });

  navigation.navigate('connectors', { connector: 'example' });
  await vi.waitFor(() => expect(page.querySelector('h1')?.textContent).toBe('Example'));
  expect(button(/^Set up$/, page)).toBeDefined();
  expect(button(/^Connect to Switch$/, page)).toBeUndefined();
});

it('tells anyone else who sets the app up, with no button to press', async () => {
  admin.administers = true;
  const page = await discover([NOT_SET_UP]);

  const card = button(/^Example/, grid(page)!)!;
  expect(card.textContent).toMatch(/Unavailable/);
  expect(card.textContent).toContain('Ask whoever runs your Switch server to set it up.');
  expect(card.textContent).not.toContain('Switch dashboard');
  expect(page.querySelector('button[aria-label="Set up Example"]')).toBeNull();
  expect(page.querySelector('button[aria-label="Connect Example"]')).toBeNull();

  await act(async () => card.click());
  await vi.waitFor(() => expect(page.querySelector('h1')?.textContent).toBe('Example'));
  expect(button(/^Set up$/, page)).toBeUndefined();
  expect(button(/^Connect to Switch$/, page)).toBeUndefined();
});

it("says GitHub can't work on a server without https, and offers this computer's sign-in instead", async () => {
  admin.operator = true;
  server.managed = true;
  const github = entry({
    slug: 'github',
    name: 'GitHub',
    connectable: false,
    unavailable_reason: "GitHub can't be used on this server.",
    unavailable_code: 'needs_https',
  });
  workspaces.getServiceConnections.mockResolvedValue([github]);
  const page = await render();
  await vi.waitFor(() => expect(grid(page)).not.toBeNull());
  await act(async () => page.querySelector<HTMLElement>('button[aria-label="Discover"]')!.click());
  await vi.waitFor(() => expect(button(/^GitHub/, grid(page)!)).toBeDefined());

  const card = button(/^GitHub/, grid(page)!)!;
  expect(card.textContent).toMatch(/Unavailable/);
  expect(card.textContent).toContain("this computer's own GitHub sign-in");
  expect(page.querySelector('button[aria-label="Set up GitHub"]')).toBeNull();
  expect(page.querySelector('button[aria-label="Connect GitHub"]')).toBeNull();
});

it('lets a workspace admin turn on a service the workspace has off, from its card', async () => {
  admin.administers = true;
  const off = entry({ slug: 'example', name: 'Example', workspace_enabled: false });
  workspaces.setWorkspaceService.mockResolvedValue({
    slug: 'example',
    enabled: true,
    warning: null,
  });
  const page = await discover([off]);

  const turnOn = page.querySelector<HTMLButtonElement>('button[aria-label="Turn on Example"]');
  expect(turnOn).not.toBeNull();
  workspaces.getServiceConnections.mockResolvedValue([{ ...off, workspace_enabled: true }]);
  await act(async () => turnOn!.click());

  expect(workspaces.setWorkspaceService).toHaveBeenCalledWith({
    workspaceId: 'workspace',
    service: 'example',
    enabled: true,
  });
  await vi.waitFor(() =>
    expect(page.querySelector('button[aria-label="Connect Example"]')).not.toBeNull()
  );
});

it('tells a member to ask a workspace admin about a service the workspace has off', async () => {
  const page = await discover([
    entry({ slug: 'example', name: 'Example', workspace_enabled: false }),
  ]);

  expect(button(/^Example/, grid(page)!)!.textContent).toContain(
    'Ask a workspace admin to turn it on.'
  );
  expect(page.querySelector('button[aria-label="Turn on Example"]')).toBeNull();
});

it('shows the real error when the catalog cannot be read, with Retry', async () => {
  workspaces.getServiceConnections.mockRejectedValue(
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
  const page = await render();

  await vi.waitFor(() =>
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not load the connectors. (HTTP 404: Not Found)'
    )
  );
  expect(grid(page)).toBeNull();

  workspaces.getServiceConnections.mockResolvedValue(CATALOG);
  await act(async () => button(/^retry$/i, page)!.click());
  await vi.waitFor(() => expect(grid(page)).not.toBeNull());
});

/** The catalog and agents as the server answers before and after Atlassian is disconnected. */
function serveDisconnect(): void {
  let connected = true;
  workspaces.getServiceConnections.mockImplementation(async () =>
    CATALOG.map((item) =>
      item.slug === 'atlassian' && !connected
        ? { ...item, status: 'not_connected', external_identity: null }
        : item
    )
  );
  workspaces.getConnectionAgents.mockImplementation(async () => [
    { agent_id: 'm1', name: 'M1', granted: connected, addressing_open: false },
  ]);
  workspaces.disconnectService.mockImplementation(async () => {
    connected = false;
    return { warning: null };
  });
}

async function openAtlassian(page: HTMLElement): Promise<void> {
  await vi.waitFor(() => expect(button(/^Atlassian/, grid(page)!)).toBeDefined());
  await act(async () => button(/^Atlassian/, grid(page)!)!.click());
  await vi.waitFor(() => expect(page.querySelector('h1')?.textContent).toBe('Atlassian'));
  await vi.waitFor(() =>
    expect(page.querySelector('[role="list"][aria-label="Agents"]')?.textContent).toContain('M1')
  );
}

async function disconnect(page: HTMLElement): Promise<void> {
  await act(async () => button(/^Disconnect$/, page)!.click());
  const dialog = () => document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
  await vi.waitFor(() => expect(dialog()?.textContent).toContain('M1 loses Atlassian.'));
  await act(async () => button(/^Disconnect$/, dialog()!)!.click());
  await vi.waitFor(() => expect(dialog()).toBeNull());
}

it('offers Connect on the profile after a disconnect, made in the workspace shown', async () => {
  serveDisconnect();
  const page = await render();
  await openAtlassian(page);

  await disconnect(page);
  expect(workspaces.disconnectService).toHaveBeenCalledWith({
    workspaceId: 'workspace',
    service: 'atlassian',
  });
  expect(button(/^Connect to Switch$/, page)).toBeDefined();
  expect(button(/^Disconnect$/, page)).toBeUndefined();
  expect(page.textContent).not.toContain('Connected as ada');
  expect(page.textContent).toContain('None of your agents use Atlassian yet.');
  expect(page.querySelector('[role="list"][aria-label="Agents"]')).toBeNull();
});

it('says on the profile when re-reading the catalog fails, with Retry', async () => {
  serveDisconnect();
  const page = await render();
  await openAtlassian(page);
  const serve = workspaces.getServiceConnections.getMockImplementation()!;
  workspaces.getServiceConnections.mockRejectedValue(new Error('Switch is down.'));

  await disconnect(page);
  await vi.waitFor(() =>
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not load the connectors.'
    )
  );

  workspaces.getServiceConnections.mockImplementation(serve);
  await act(async () => button(/^retry$/i, page)!.click());
  await vi.waitFor(() => expect(button(/^Connect to Switch$/, page)).toBeDefined());
  expect(page.querySelector('[role="alert"]')).toBeNull();
});

it("shows GitHub's repositories on its profile, and adds an agent with them", async () => {
  workspaces.getServiceConnections.mockResolvedValue([
    entry({
      slug: 'github',
      name: 'GitHub',
      status: 'connected',
      external_identity: 'ada',
      pass_through: false,
    }),
  ]);
  workspaces.getGitHubConnection.mockResolvedValue({
    status: 'connected',
    login: 'ada',
    install_url: 'https://github.com/apps/example/installations/new',
    installations: [
      {
        id: 7,
        account: 'ada',
        repositories: [
          { id: 1, name: 'ada/one' },
          { id: 2, name: 'ada/two' },
        ],
      },
    ],
  });
  workspaces.getConnectionAgents.mockResolvedValue([
    { agent_id: 'm1', name: 'M1', granted: false, addressing_open: false },
  ]);
  workspaces.setServiceGrant.mockResolvedValue(null);
  const page = await render();

  await vi.waitFor(() => expect(button(/^GitHub/, grid(page)!)).toBeDefined());
  await act(async () => button(/^GitHub/, grid(page)!)!.click());
  await vi.waitFor(() => expect(page.querySelector('h1')?.textContent).toBe('GitHub'));
  const repositories = () => page.querySelector('section[aria-label="Repositories"]')!;
  await vi.waitFor(() => expect(repositories().textContent).toContain('2 repositories'));
  // The account card opens to its list; the names are not on the page before that.
  expect(repositories().textContent).not.toContain('ada/one');
  await act(async () =>
    repositories()
      .querySelector<HTMLButtonElement>('button[aria-label="Show the repositories under ada"]')!
      .click()
  );
  await vi.waitFor(() => expect(repositories().textContent).toContain('ada/one'));
  expect(button(/^Choose repositories/, page)).toBeUndefined();
  await act(async () => button(/^Change repositories/, repositories())!.click());
  expect(switchServers.openGitHubInstallation).toHaveBeenCalledWith('server');

  // Adding an agent: nothing is chosen yet, so no agent can be added.
  await act(async () => button(/^Add agent$/, page)!.click());
  await vi.waitFor(() => expect(page.textContent).toContain('No repositories chosen yet'));
  await vi.waitFor(() => expect(button(/M1/, page)).toBeDefined());
  expect(button(/M1/, page)!.disabled).toBe(true);

  // Add all, then drop one: the chips are the choice.
  await act(async () => button(/^Choose repositories$/, page)!.click());
  await vi.waitFor(() => expect(button(/^Add all$/, page)).toBeDefined());
  await act(async () => button(/^Add all$/, page)!.click());
  const chips = () => page.querySelector('[aria-label="Chosen repositories"]');
  await vi.waitFor(() => expect(chips()?.textContent).toContain('ada/two'));
  expect(page.textContent).toContain('2 of 2 chosen');
  await act(async () =>
    page.querySelector<HTMLButtonElement>('button[aria-label="Remove ada/one"]')!.click()
  );
  await vi.waitFor(() => expect(chips()?.textContent).not.toContain('ada/one'));
  await act(async () => button(/^Done$/, page)!.click());
  await vi.waitFor(() =>
    expect(page.textContent).toContain('Agents you add get read access to 1 repository.')
  );
  expect(button(/^Change$/, page)).toBeDefined();

  await vi.waitFor(() => expect(button(/M1/, page)!.disabled).toBe(false));
  await act(async () => button(/M1/, page)!.click());
  expect(workspaces.setServiceGrant).toHaveBeenCalledWith({
    workspaceId: 'workspace',
    agentId: 'm1',
    service: 'github',
    access: 'read',
    resources: { installation_id: 7, repository_ids: [2] },
  });
});

it('shows a connection the workspace has switched off as off, not as connected', async () => {
  workspaces.getServiceConnections.mockResolvedValue([
    entry({ slug: 'atlassian', name: 'Atlassian', status: 'connected', workspace_enabled: false }),
  ]);
  const page = await render();

  await vi.waitFor(() => expect(button(/^Atlassian/, grid(page)!)).toBeDefined());
  expect(page.querySelector('[aria-label="Atlassian connected"]')).toBeNull();
  expect(button(/^Atlassian/, grid(page)!)!.textContent).toContain('Off in this workspace');
  expect(button(/^Atlassian/, grid(page)!)!.textContent).toContain(
    'Ask a workspace admin to turn it on.'
  );
});

it('offers an admin the way to the workspace switches, and nobody else', async () => {
  workspaces.getServiceConnections.mockResolvedValue(CATALOG);
  let page = await render();
  await vi.waitFor(() => expect(grid(page)).not.toBeNull());
  expect(button(/Manage in Admin/, page)).toBeUndefined();
  expect(page.querySelector('button[aria-label="Workspace"]')).toBeNull();
  await act(async () => root!.unmount());
  root = null;
  container!.remove();

  admin.administers = true;
  page = await render();
  await vi.waitFor(() => expect(button(/Manage in Admin/, page)).toBeDefined());
  await act(async () => button(/Manage in Admin/, page)!.click());
  expect(navigation.view()).toBe('admin');
  expect(navigation.params()).toEqual({ serverId: 'server', section: 'connectors' });
});
