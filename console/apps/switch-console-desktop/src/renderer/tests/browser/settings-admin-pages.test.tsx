/**
 * The admin pages in Settings, for the workspace in scope: a workspace
 * admin's switch for each service, drawn as tiles, and its decision routing.
 * A switch asks before it reaches other people, shows what the server says
 * rather than what was asked, and keeps its place when it flips. Whoever runs
 * a Switch with no web gateway also has the apps connectors sign in through,
 * each opening to its own profile. Which of these the menu offers whom is
 * `settingsSections`'s, tested on its own.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkspaceService } from '@shared/core/switch-servers/connection-catalog';
import type { ConnectorApp } from '@shared/core/switch-servers/connector-apps';

const workspaces = vi.hoisted(() => ({
  getWorkspaceServices: vi.fn(),
  setWorkspaceService: vi.fn(),
  getServiceConnections: vi.fn(),
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
const switchServers = vi.hoisted(() => ({
  getDecisionSettings: vi.fn(),
  getConnectorApps: vi.fn(),
  checkConnectorApp: vi.fn(),
  saveConnectorApp: vi.fn(),
  getConnectorAppImpact: vi.fn(),
  getTrustSettings: vi.fn(),
  getWorkspaceGuardrails: vi.fn(),
}));
const admin = vi.hoisted(() => ({
  administers: true,
  operator: false,
  servesGateway: false,
  organizationAdmin: false,
}));
/** The dialogs asked for, by id; each is answered by the test. */
const modals = vi.hoisted(
  () =>
    [] as {
      id: string;
      title: string;
      description: string;
      mode?: string;
      app?: { slug: string };
      onSuccess: () => void;
    }[]
);
const confirmations = {
  get length() {
    return modals.filter((modal) => modal.id === 'confirmActionModal').length;
  },
  at: (index: number) => modals.filter((modal) => modal.id === 'confirmActionModal')[index]!,
};

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { workspaces, featureFlags, switchServers },
}));

vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {
    onServerInScope: () => ({
      id: 'workspace',
      name: 'Acme',
      tenantId: 'tenant-1',
      organizationRole: admin.organizationAdmin ? 'org_admin' : null,
    }),
  },
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    servers: [{ id: 'server', name: 'Dev Server' }],
    activeServer: {
      id: 'server',
      name: 'Dev Server',
      url: 'https://switch.example.com',
      dashboardUrl: null,
    },
    serverById: () => ({ id: 'server', name: 'Dev Server' }),
    statusFor: () => ({
      connected: true,
      user: { id: 'u', name: 'Ada', role: admin.operator ? 'admin' : 'member' },
    }),
  },
}));

// Connector apps are in the web gateway; Admin keeps them for a Switch without one.
vi.mock('@renderer/features/switch-servers/server-gateway', () => ({
  servesWebGateway: () => admin.servesGateway,
}));

vi.mock('@renderer/features/switch-servers/workspace-admin', () => ({
  administersWorkspaceInScope: () => admin.administers || admin.operator,
  operatesServer: () => admin.operator,
}));

/** Stands in for the app's navigation: a tile opens its profile by navigating. */
const navigation = vi.hoisted(() => {
  // Opened on the connector switches, which most of these tests are about.
  let params: Record<string, string | undefined> = { tab: 'connectors' };
  const listeners = new Set<() => void>();
  return {
    params: () => params,
    navigate: (_view: string, next?: Record<string, string | undefined>) => {
      params = { ...next };
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: () => {
      params = { tab: 'connectors' };
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

const openExternalUrl = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@renderer/lib/open-external', () => ({ openExternalUrl }));
const openServerPage = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@renderer/features/switch-servers/open-server-page', () => ({ openServerPage }));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: (id: string) => (args: Omit<(typeof modals)[number], 'id'>) =>
    modals.push({ id, ...args }),
  useModalContext: () => ({ setCloseGuard: () => {} }),
}));

import { ConnectorAppSetupDialog } from '@renderer/features/admin/connector-app-dialogs';
import {
  ConnectorAppsSettingsPage,
  ConnectorsSettingsPage,
  DecisionRoutingSettingsPage,
  GuardrailsSettingsPage,
} from '@renderer/features/settings/pages/admin-pages';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';

function service(overrides: Partial<WorkspaceService>): WorkspaceService {
  return {
    slug: 'example',
    name: 'Example',
    enabled: true,
    updated_by_name: null,
    updated_at: null,
    connected_members: 0,
    granted_agents: 0,
    unavailable_code: null,
    unavailable_reason: null,
    can_change: true,
    organization_locked: false,
    ...overrides,
  };
}

const SERVICES = [
  service({ slug: 'atlassian', name: 'Atlassian', connected_members: 3, granted_agents: 2 }),
  service({ slug: 'figma', name: 'Figma' }),
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  navigation.reset();
  admin.administers = true;
  admin.operator = false;
  admin.servesGateway = false;
  admin.organizationAdmin = false;
  openExternalUrl.mockClear();
  openServerPage.mockClear();
  modals.length = 0;
  for (const mock of Object.values(workspaces)) mock.mockReset();
  for (const mock of Object.values(switchServers)) mock.mockReset();
  workspaces.getServiceConnections.mockResolvedValue([]);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

/** The Settings tab navigation is on, as Settings draws it beside its menu. */
function Tab() {
  const { useSyncExternalStore } = React;
  const { tab } = useSyncExternalStore(navigation.subscribe, navigation.params);
  if (tab === 'decision-routing') return <DecisionRoutingSettingsPage />;
  if (tab === 'connector-apps') return <ConnectorAppsSettingsPage />;
  if (tab === 'guardrails') return <GuardrailsSettingsPage />;
  return <ConnectorsSettingsPage />;
}

async function render(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Tab />
      </QueryClientProvider>
    )
  );
  return container;
}

function tiles(page: HTMLElement): HTMLElement | null {
  return page.querySelector<HTMLElement>('[role="group"][aria-label="Workspace connectors"]');
}

function switchFor(page: HTMLElement, name: string): HTMLElement | null {
  return page.querySelector<HTMLElement>(`[aria-label="${name} for this workspace"]`);
}

it('says what a workspace admin can do here, and draws each service as a tile with who it uses', async () => {
  workspaces.getWorkspaceServices.mockResolvedValue(SERVICES);
  const page = await render();

  await vi.waitFor(() => expect(tiles(page)).not.toBeNull());
  expect(workspaces.getWorkspaceServices).toHaveBeenCalledWith('workspace');
  expect(page.textContent).toContain('Choose which services people in Acme can connect');
  expect(page.querySelector('[role="note"]')!.textContent).toBe(
    'As a workspace admin, you are able to turn each service on or off for everyone in Acme.'
  );
  expect(tiles(page)!.textContent).toContain('3 members connected · 2 agents use it');
  expect(tiles(page)!.textContent).toContain('Nobody has connected it yet');
});

it('asks before switching off a service people use, then shows what the server says', async () => {
  workspaces.getWorkspaceServices.mockResolvedValue(SERVICES);
  workspaces.setWorkspaceService.mockResolvedValue({
    slug: 'atlassian',
    enabled: false,
    warning: 'One session could not be reached yet.',
  });
  const page = await render();
  await vi.waitFor(() => expect(switchFor(page, 'Atlassian')).not.toBeNull());

  await act(async () => switchFor(page, 'Atlassian')!.click());
  expect(workspaces.setWorkspaceService).not.toHaveBeenCalled();
  expect(confirmations).toHaveLength(1);
  expect(confirmations.at(0).description).toBe(
    '3 members are connected and 2 agents use it. Their sessions lose it within a minute.'
  );

  workspaces.getWorkspaceServices.mockResolvedValue([
    { ...SERVICES[0], enabled: false, updated_by_name: 'Ada', updated_at: '2026-10-16T09:00:00Z' },
    SERVICES[1],
  ]);
  await act(async () => confirmations.at(0).onSuccess());

  expect(workspaces.setWorkspaceService).toHaveBeenCalledWith({
    workspaceId: 'workspace',
    service: 'atlassian',
    enabled: false,
  });
  await vi.waitFor(() =>
    expect(tiles(page)!.textContent).toContain('Switched off by Ada, Oct 16, 2026.')
  );
  expect(switchFor(page, 'Atlassian')!.getAttribute('aria-checked')).toBe('false');
  expect(page.querySelector('[role="status"]')?.textContent).toBe(
    'One session could not be reached yet.'
  );
  // Still first: a tile keeps its place when it flips.
  expect(tiles(page)!.firstElementChild!.textContent!.trim()).toMatch(/^Atlassian/);
});

it('switches a service nobody uses without asking, and leaves it as it was on a failure', async () => {
  workspaces.getWorkspaceServices.mockResolvedValue(SERVICES);
  workspaces.setWorkspaceService.mockRejectedValue(new Error('Switch is down.'));
  const page = await render();
  await vi.waitFor(() => expect(switchFor(page, 'Figma')).not.toBeNull());

  await act(async () => switchFor(page, 'Figma')!.click());

  expect(confirmations).toHaveLength(0);
  await vi.waitFor(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
  expect(page.querySelector('[role="alert"]')!.textContent).toContain('Switch is down.');
  expect(switchFor(page, 'Figma')!.getAttribute('aria-checked')).toBe('true');
});

it("says under a tile why the server can't serve the service, and keeps its switch", async () => {
  workspaces.getWorkspaceServices.mockResolvedValue([
    service({
      slug: 'atlassian',
      name: 'Atlassian',
      unavailable_code: 'app_not_set_up',
      unavailable_reason: 'Atlassian is not set up on this server.',
    }),
    service({ slug: 'figma', name: 'Figma' }),
  ]);
  const page = await render();
  await vi.waitFor(() => expect(tiles(page)).not.toBeNull());

  const [atlassian, figma] = [...tiles(page)!.children];
  expect(atlassian!.textContent).toContain('Atlassian is not set up on this server.');
  expect(switchFor(page, 'Atlassian')!.hasAttribute('data-disabled')).toBe(false);
  expect(figma!.textContent).not.toContain('not set up');
});

it('holds a switch the organization locked, and says so', async () => {
  workspaces.getWorkspaceServices.mockResolvedValue([
    service({ slug: 'atlassian', name: 'Atlassian', can_change: false, organization_locked: true }),
    service({ slug: 'figma', name: 'Figma' }),
  ]);
  const page = await render();
  await vi.waitFor(() => expect(tiles(page)).not.toBeNull());

  const [atlassian, figma] = [...tiles(page)!.children];
  expect(atlassian!.textContent).toContain('Set by your organization.');
  expect(switchFor(page, 'Atlassian')!.hasAttribute('data-disabled')).toBe(true);
  expect(figma!.textContent).not.toContain('Set by your organization.');
  expect(switchFor(page, 'Figma')!.hasAttribute('data-disabled')).toBe(false);
});

it('searches the tiles by name', async () => {
  workspaces.getWorkspaceServices.mockResolvedValue(SERVICES);
  const page = await render();
  await vi.waitFor(() => expect(tiles(page)).not.toBeNull());

  const search = page.querySelector<HTMLInputElement>('input[aria-label="Search services"]')!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(search, 'fig');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });

  expect(switchFor(page, 'Figma')).not.toBeNull();
  expect(switchFor(page, 'Atlassian')).toBeNull();
});

it('says when the server has no workspace switches, rather than drawing none', async () => {
  workspaces.getWorkspaceServices.mockResolvedValue(null);
  const page = await render();

  await vi.waitFor(() =>
    expect(page.textContent).toContain("This server can't switch services on or off")
  );
});

it('gives the workspace’s admins Decision routing, with service connections off too', async () => {
  featureFlags.get.mockResolvedValueOnce({
    success: true,
    data: {
      serverId: 'server',
      flags: { service_connections: false },
      fetchedAt: 1,
      error: null,
    },
  });
  switchServers.getDecisionSettings.mockResolvedValue({
    kind: 'loaded',
    settings: {
      source: 'server_default',
      effective: {
        backend: 'endpoint',
        endpoint: 'http://decision:8230',
        threshold: null,
        available: true,
        reason: null,
      },
      workspace: null,
      serverDefault: { configured: true, endpoint: 'http://decision:8230', hasApiKey: false },
      options: { haikuAnthropic: true, haikuBedrock: false },
    },
  });
  navigation.navigate('settings', { tab: 'decision-routing' });
  const page = await render();

  await vi.waitFor(() =>
    expect(page.textContent).toContain('This workspace uses the server default')
  );
  expect(switchServers.getDecisionSettings).toHaveBeenCalledWith('workspace');
  expect(page.querySelector('[role="note"]')!.textContent).toBe(
    'As a workspace admin, you are able to choose the decision service for every auto-route room in Acme.'
  );
  expect(workspaces.getWorkspaceServices).not.toHaveBeenCalled();
});

it('says so when it cannot read the decision routing, rather than drawing a guess', async () => {
  switchServers.getDecisionSettings.mockResolvedValue({ kind: 'forbidden' });
  navigation.navigate('settings', { tab: 'decision-routing' });
  const page = await render();

  await vi.waitFor(() =>
    expect(page.textContent).toContain(
      'Only an admin of this workspace can view or change its decision routing.'
    )
  );
});

const CHECKED = {
  kind: 'loaded',
  guardrails: {
    checking: true,
    policyId: 'pol_123',
    policyName: 'Default policy',
    policyUrl: 'https://app.switchagents.ai/policies/pol_123',
  },
};

it('shows a workspace admin which policy checks the workspace, read-only, powered by Switch Trust', async () => {
  switchServers.getWorkspaceGuardrails.mockResolvedValue(CHECKED);
  navigation.navigate('settings', { tab: 'guardrails' });
  const page = await render();

  await vi.waitFor(() =>
    expect(page.textContent).toContain(
      'Messages in Acme are checked by the Switch Trust policy Default policy.'
    )
  );
  expect(switchServers.getWorkspaceGuardrails).toHaveBeenCalledWith('workspace');
  expect(page.querySelector('[role="note"]')!.textContent).toBe(
    'As a workspace admin, you are able to see which guardrails check Acme. Only organization admins can change them.'
  );
  expect(button(/Change in Organization settings/, page)).toBeUndefined();
  expect(switchServers.getTrustSettings).not.toHaveBeenCalled();

  await act(async () => button(/^View policy/, page)!.click());
  expect(openExternalUrl).toHaveBeenCalledWith(
    'https://app.switchagents.ai/policies/pol_123',
    'Could not open the policy'
  );
  expect(page.textContent).toContain('Powered by Switch Trust.');
  await act(async () => button(/^Switch Trust$/, page)!.click());
  expect(openExternalUrl).toHaveBeenCalledWith(
    'https://www.switchagents.ai/trust',
    'Could not open Switch Trust'
  );
});

it('says when nothing checks the workspace', async () => {
  switchServers.getWorkspaceGuardrails.mockResolvedValue({
    kind: 'loaded',
    guardrails: { checking: false, policyId: null, policyName: null, policyUrl: null },
  });
  navigation.navigate('settings', { tab: 'guardrails' });
  const page = await render();

  await vi.waitFor(() =>
    expect(page.textContent).toContain('No guardrails check messages in Acme yet.')
  );
  expect(button(/^View policy/, page)).toBeUndefined();
});

it('sends an organization admin to Organization settings to change them', async () => {
  admin.organizationAdmin = true;
  switchServers.getWorkspaceGuardrails.mockResolvedValue(CHECKED);
  navigation.navigate('settings', { tab: 'guardrails' });
  const page = await render();

  await vi.waitFor(() => expect(button(/Change in Organization settings/, page)).toBeDefined());
  expect(page.querySelector('[role="note"]')!.textContent).toBe(
    'As an organization admin, you are able to change the guardrails for every workspace in your organization.'
  );
  // Organization settings shows the policy too: one way there, not two.
  expect(button(/^View policy/, page)).toBeUndefined();
  await act(async () => button(/Change in Organization settings/, page)!.click());
  expect(openServerPage).toHaveBeenCalledWith(
    'server',
    expect.stringMatching(/\/settings\/org\/guardrails\?.*tenant-1/)
  );
});

it('keeps the whole-server form for whoever runs a server from before organizations set their own', async () => {
  admin.operator = true;
  switchServers.getWorkspaceGuardrails.mockResolvedValue({ kind: 'unsupported' });
  switchServers.getTrustSettings.mockResolvedValue({
    kind: 'loaded',
    settings: {
      endpoint: 'https://trust.example',
      policyId: 'pol_1',
      hasApiKey: true,
      apiKeyLast4: 'ab12',
      enabled: true,
    },
  });
  navigation.navigate('settings', { tab: 'guardrails' });
  const page = await render();

  await vi.waitFor(() => expect(page.textContent).toContain('Switch Trust Integration'));
});

it('tells a workspace admin on such a server who can change them', async () => {
  switchServers.getWorkspaceGuardrails.mockResolvedValue({ kind: 'unsupported' });
  navigation.navigate('settings', { tab: 'guardrails' });
  const page = await render();

  await vi.waitFor(() =>
    expect(page.textContent).toContain(
      'Dev Server sets one set of guardrails for the whole server. Whoever runs it can change them.'
    )
  );
  expect(switchServers.getTrustSettings).not.toHaveBeenCalled();
});

function connectorApp(overrides: Partial<ConnectorApp>): ConnectorApp {
  return {
    slug: 'google-workspace',
    name: 'Google Workspace',
    kind: 'oauth_client',
    source: 'saved',
    configuration_variables: ['GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH'],
    deprecated: false,
    client_id: 'example-client-id',
    saved_client_id: 'example-client-id',
    fields: {},
    secrets: { client_secret: { set: true, last4: 'ab12' } },
    saved_ignored: false,
    unreadable: false,
    load_error: null,
    redirect_uri: 'https://switch.example.test/callback',
    redirect_uris: ['https://switch.example.test/callback'],
    needs_public_url: true,
    scopes: [],
    setup_blocked: null,
    read_only: false,
    lacks_write: [],
    install_url: null,
    updated_by_name: 'Ada',
    updated_at: '2026-10-15T10:00:00Z',
    connected_members: 12,
    workspaces: 3,
    stale_connections: 0,
    ...overrides,
  };
}

const GITHUB_NOT_SET_UP = connectorApp({
  slug: 'github',
  name: 'GitHub',
  kind: 'github_app',
  source: 'none',
  client_id: null,
  saved_client_id: null,
  secrets: {},
  connected_members: 0,
  workspaces: 0,
});
const GOOGLE = connectorApp({});

function appTiles(page: HTMLElement): HTMLElement | null {
  return page.querySelector<HTMLElement>('[role="group"][aria-label="Connector apps"]');
}

function button(name: RegExp, within: ParentNode): HTMLButtonElement | undefined {
  return [...within.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

it("gives the server's operator Connector apps, the app needing set-up first", async () => {
  admin.operator = true;
  switchServers.getConnectorApps.mockResolvedValue({
    public_url: 'https://switch.example.test',
    apps: [GOOGLE, GITHUB_NOT_SET_UP],
  });
  navigation.navigate('settings', { tab: 'connector-apps' });
  const page = await render();
  await vi.waitFor(() => expect(appTiles(page)).not.toBeNull());
  expect(page.querySelector('[role="note"]')!.textContent).toBe(
    'As the person who runs Dev Server, you are able to set up the apps its connectors sign in through.'
  );
  expect(switchServers.getConnectorApps).toHaveBeenCalledWith('server');
  expect(page.textContent).toContain(
    'Some connectors sign people in through an app you register with the vendor. Set each up once, and every workspace on Dev Server uses it.'
  );
  const [first, second] = [...appTiles(page)!.children];
  expect(first!.textContent).toContain('GitHub');
  expect(first!.textContent).toContain('Not set up');
  expect(second!.textContent).toContain('Used by 12 people in 3 workspaces');
  // A working app's tile carries no button: checking it is the profile's.
  expect(second!.querySelectorAll('button')).toHaveLength(1);

  await act(async () =>
    page.querySelector<HTMLElement>('button[aria-label="Set up GitHub"]')!.click()
  );
  expect(modals.at(-1)).toMatchObject({
    id: 'connectorAppSetupModal',
    mode: 'set_up',
    app: { slug: 'github' },
  });
});

it("opens an app's profile from its tile, and a failed check stays on the tile after", async () => {
  admin.operator = true;
  switchServers.getConnectorApps.mockResolvedValue({
    public_url: 'https://switch.example.test',
    apps: [GOOGLE],
  });
  switchServers.checkConnectorApp.mockResolvedValue({
    ok: false,
    checks: [
      {
        name: 'client',
        ok: true,
        message: 'Google knows the client.',
        field: null,
        note: 'Have someone else connect once.',
      },
      {
        name: 'secret',
        ok: false,
        message: 'Google refused the secret.',
        field: 'client_secret',
        note: null,
      },
    ],
  });
  navigation.navigate('settings', { tab: 'connector-apps' });
  const page = await render();
  await vi.waitFor(() => expect(appTiles(page)).not.toBeNull());

  await act(async () => button(/^Google Workspace/, appTiles(page)!)!.click());
  expect(navigation.params()).toEqual({ tab: 'connector-apps', app: 'google-workspace' });
  await vi.waitFor(() => expect(page.querySelector('h1')?.textContent).toBe('Google Workspace'));
  const credentials = page.querySelector('section dl')!;
  expect([...credentials.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual([
    'Client ID',
    'Client secret',
  ]);
  expect(credentials.textContent).toContain('example-client-id');
  expect(credentials.textContent).toContain('•••• ab12');
  expect(page.querySelector('button[aria-label="Copy example-client-id"]')).not.toBeNull();

  await act(async () => button(/^Check it works$/, page)!.click());
  await vi.waitFor(() => expect(page.textContent).toContain('Google refused the secret.'));
  const said = page.querySelector('[aria-label="What the vendor said"]')!;
  expect(said.textContent).toContain('Google knows the client.');
  expect(said.querySelector('strong')?.textContent).toBe('Note:');
  expect(said.textContent).toContain('Note: Have someone else connect once.');
  // The fix is now the obvious button.
  expect(button(/^Update secret$/, page)).toBeDefined();

  const back = [...page.querySelectorAll('button')].find(
    (b) => b.textContent === 'Connector apps'
  )!;
  await act(async () => back.click());
  expect(navigation.params()).toEqual({ tab: 'connector-apps' });
  await vi.waitFor(() => expect(appTiles(page)).not.toBeNull());
  expect(appTiles(page)!.textContent).toContain('Needs attention');
  expect(appTiles(page)!.textContent).toContain('Google refused the secret.');
});

it('says what is missing before an app can be set up, and holds the button', async () => {
  admin.operator = true;
  switchServers.getConnectorApps.mockResolvedValue({ public_url: null, apps: [GITHUB_NOT_SET_UP] });
  navigation.navigate('settings', { tab: 'connector-apps' });
  const page = await render();

  await vi.waitFor(() => expect(page.textContent).toContain('Set GATEWAY_PUBLIC_URL first'));
  expect(
    page.querySelector<HTMLButtonElement>('button[aria-label="Set up GitHub"]')!.disabled
  ).toBe(true);
});

const SAVED_CHECK = {
  name: 'client',
  ok: true,
  message: 'Google Workspace accepts this client ID and secret.',
  field: null,
  note: "Switch can't check the redirect URI. Connect once to confirm.",
};

it('marks the value the vendor refused, and saves once it is right', async () => {
  const onSuccess = vi.fn();
  switchServers.saveConnectorApp
    .mockResolvedValueOnce({
      kind: 'refused',
      message: 'Google refused the secret.',
      field: 'client_secret',
      checks: [],
    })
    .mockResolvedValueOnce({ kind: 'saved', app: GOOGLE, checks: [SAVED_CHECK] });
  switchServers.getConnectorApps.mockResolvedValue({ public_url: null, apps: [GOOGLE] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // Kept as the app keeps it, for the app's page to read after the save.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Dialog open>
          <DialogContent>
            <ConnectorAppSetupDialog
              serverId="server"
              app={connectorApp({ source: 'none', client_id: null, saved_client_id: null })}
              publicUrl="https://switch.example.test"
              mode="set_up"
              onSuccess={onSuccess}
              onClose={() => {}}
            />
          </DialogContent>
        </Dialog>
      </QueryClientProvider>
    )
  );
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain('Step 1 of 2');
  expect(dialog.textContent).toContain('Who will connect?');

  await act(async () => button(/^Next$/, dialog)!.click());
  const type = async (input: HTMLInputElement, value: string) =>
    act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await type(dialog.querySelector<HTMLInputElement>('#connector-app-client_id')!, ' my-client ');
  const secret = dialog.querySelector<HTMLInputElement>('#connector-app-client_secret')!;
  await type(secret, 'wrong');

  await act(async () => button(/^Check and save$/, dialog)!.click());
  await vi.waitFor(() =>
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('Google refused the secret.')
  );
  expect(secret.getAttribute('aria-invalid')).toBe('true');
  expect(switchServers.saveConnectorApp).toHaveBeenCalledWith({
    serverId: 'server',
    service: 'google-workspace',
    input: { client_id: 'my-client', client_secret: 'wrong', replace: false },
  });
  expect(onSuccess).not.toHaveBeenCalled();

  await type(secret, 'right');
  expect(dialog.querySelector('[role="alert"]')).toBeNull();
  await act(async () => button(/^Check and save$/, dialog)!.click());
  await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith('Google Workspace is ready.'));
  // What the save's check said is kept for the app's page, note and all.
  expect(client.getQueryData(['connector-app-checks', 'server', 'google-workspace'])).toEqual([
    SAVED_CHECK,
  ]);
});
