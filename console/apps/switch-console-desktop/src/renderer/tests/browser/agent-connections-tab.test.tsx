/**
 * The drawer on an agent's Connectors tab for a service the server or the
 * workspace stops: it says why, as the service's card does, and offers no
 * control that the server would refuse. A grant there can still be removed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import type { ServiceGrant } from '@shared/core/switch-servers/service-grants';

const workspaces = vi.hoisted(() => ({
  getServiceGrants: vi.fn(),
  getServiceConnections: vi.fn(),
  getGitHubConnection: vi.fn(),
  setServiceGrant: vi.fn(),
  removeServiceGrant: vi.fn(),
  updateAddressingPolicy: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { workspaces },
}));

import { AgentConnectionsTab } from '@renderer/features/managed-agents/agent-connections-tab';

const GITHUB = {
  status: 'connected' as const,
  login: 'ada-gh',
  install_url: 'https://github.com/apps/example/installations/new',
  installations: [
    {
      id: 7,
      account: 'example-org',
      repositories: [{ id: 70, name: 'example-org/project' }],
    },
  ],
};

const SWITCHED_OFF =
  'GitHub is not enabled in this workspace. Ask a workspace admin; they switch it on under Connectors.';

function entry(slug: string, overrides: Partial<ConnectionCatalogEntry>): ConnectionCatalogEntry {
  return {
    slug,
    name: slug[0].toUpperCase() + slug.slice(1),
    category: 'Tools',
    description: `What ${slug} is.`,
    enabled: true,
    auth_type: 'oauth',
    connectable: true,
    status: 'connected',
    unavailable_reason: null,
    unavailable_code: null,
    pass_through: true,
    token_lifetime: 3600,
    agent_access_note: null,
    loopback_ports: null,
    key: null,
    external_identity: null,
    consent: null,
    read_only_reason: null,
    sign_in_choices: null,
    paste: [],
    method: null,
    access_note: null,
    reconnect_code: null,
    reconnect_reason: null,
    choices: null,
    workspace_enabled: null,
    organization_locked: false,
    ...overrides,
  };
}

const github = (overrides: Partial<ConnectionCatalogEntry>) =>
  entry('github', { name: 'GitHub', pass_through: false, ...overrides });

const GITHUB_GRANT: ServiceGrant = {
  service: 'github',
  name: 'GitHub',
  access: 'write',
  resources: { installation_id: 7, repository_ids: [70] },
  summary: 'helper can read and push to 1 repository, acting as the GitHub App.',
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  for (const mock of Object.values(workspaces)) mock.mockReset();
  workspaces.getGitHubConnection.mockResolvedValue(GITHUB);
  workspaces.setServiceGrant.mockResolvedValue(null);
  workspaces.removeServiceGrant.mockResolvedValue(null);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(
  services: ConnectionCatalogEntry[],
  grants: ServiceGrant[]
): Promise<HTMLElement> {
  workspaces.getServiceConnections.mockResolvedValue(services);
  workspaces.getServiceGrants.mockResolvedValue({ grants, addressing_open: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <AgentConnectionsTab
          serverId="server"
          workspaceId="workspace"
          agentId="agent"
          agentName="helper"
          cloud={false}
        />
      </QueryClientProvider>
    )
  );
  return container;
}

function card(within: ParentNode, name: string): HTMLButtonElement | undefined {
  return [...within.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find(
    (candidate) => candidate.textContent?.includes(name)
  );
}

function button(within: ParentNode, name: string): HTMLButtonElement | undefined {
  return [...within.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === name
  );
}

/** Opens the card's drawer and returns it. */
async function openDrawer(el: HTMLElement, name: string): Promise<HTMLElement> {
  await vi.waitFor(() => expect(card(el, name)).toBeDefined());
  await act(async () => card(el, name)!.click());
  const drawer = el.querySelector<HTMLElement>('[role="dialog"]');
  expect(drawer?.getAttribute('aria-label')).toBe(name);
  return drawer!;
}

it('offers to change a GitHub grant nothing stops', async () => {
  const el = await render([github({})], [GITHUB_GRANT]);
  const drawer = await openDrawer(el, 'GitHub');

  await vi.waitFor(() => expect(button(drawer, 'Change')).toBeDefined());
  await act(async () => button(drawer, 'Change')!.click());
  expect(drawer.textContent).toContain('Change which repositories helper reaches');
});

it('says why a GitHub the workspace switched off does nothing, as its card does, and offers only Remove', async () => {
  const el = await render([github({ workspace_enabled: false })], [GITHUB_GRANT]);
  const drawer = await openDrawer(el, 'GitHub');
  expect(card(el, 'GitHub')!.textContent).toContain(SWITCHED_OFF);

  await vi.waitFor(() => expect(drawer.textContent).toContain('example-org/project'));
  expect(drawer.textContent).toContain(SWITCHED_OFF);
  expect(drawer.textContent).toContain(GITHUB_GRANT.summary);
  expect(button(drawer, 'Change')).toBeUndefined();
  expect(drawer.textContent).not.toContain('Change which repositories');
  expect(drawer.querySelector('input[aria-label="Add repository"]')).toBeNull();

  await act(async () => button(drawer, 'Remove')!.click());
  await vi.waitFor(() =>
    expect(workspaces.removeServiceGrant).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      agentId: 'agent',
      service: 'github',
    })
  );
});

it('says why GitHub cannot be turned on here in place of its form', async () => {
  const reason =
    "GitHub can't be used here: it needs Switch to have an https address, or an http one on your own computer (localhost or 127.0.0.1).";
  const el = await render(
    [github({ unavailable_reason: reason, unavailable_code: 'needs_https' })],
    []
  );
  const drawer = await openDrawer(el, 'GitHub');
  expect(card(el, 'GitHub')!.textContent).toContain(reason);

  expect(drawer.textContent).toContain(reason);
  expect(drawer.textContent).not.toContain('Turn GitHub on for helper');
  expect(button(drawer, 'Turn on')).toBeUndefined();
  expect(drawer.querySelector('input[aria-label="Add repository"]')).toBeNull();
  expect(workspaces.setServiceGrant).not.toHaveBeenCalled();
});

it('says why a grant it has nothing to change on does nothing, and can remove it', async () => {
  const reason = 'Switched off here.';
  const el = await render(
    [entry('gitlab', { pass_through: false, unavailable_reason: reason })],
    [{ ...GITHUB_GRANT, service: 'gitlab', name: 'Gitlab', summary: 'helper can read Gitlab.' }]
  );
  const drawer = await openDrawer(el, 'Gitlab');

  expect(drawer.textContent).toContain(reason);
  expect(button(drawer, 'Change')).toBeUndefined();
  expect(button(drawer, 'Remove')).toBeDefined();
});

it('says once why an on/off service does nothing, and can still turn it off', async () => {
  const reason =
    'Example is not enabled in this workspace. Ask a workspace admin; they switch it on under Connectors.';
  const el = await render(
    [entry('example', { workspace_enabled: false })],
    [{ ...GITHUB_GRANT, service: 'example', name: 'Example', resources: {}, summary: 'On.' }]
  );
  const drawer = await openDrawer(el, 'Example');

  expect(drawer.textContent!.split(reason)).toHaveLength(2);
  await act(async () =>
    drawer.querySelector<HTMLElement>('[aria-label="Example for helper"]')!.click()
  );
  await vi.waitFor(() =>
    expect(workspaces.removeServiceGrant).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      agentId: 'agent',
      service: 'example',
    })
  );
});
