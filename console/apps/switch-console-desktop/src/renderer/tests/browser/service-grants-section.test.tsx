/**
 * An agent's Service access, in its settings: the grants with the repositories
 * they reach, a grant a cloud agent works without, the warning when anyone can
 * address the agent, and the GitHub grant form. Shown to the agent's owner
 * only: anyone else's read of the grants is refused, and the section is not
 * drawn at all.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { OWNER_ONLY_POLICY, type ServiceGrants } from '@shared/core/switch-servers/service-grants';

const agents = vi.hoisted(() => ({ getAgents: vi.fn() }));
const workspaces = vi.hoisted(() => ({
  getServiceGrants: vi.fn(),
  getServiceConnections: vi.fn(),
  getGitHubConnection: vi.fn(),
  setServiceGrant: vi.fn(),
  removeServiceGrant: vi.fn(),
  updateAddressingPolicy: vi.fn(),
}));

const serverFlags = vi.hoisted(() => ({ service_connections: true }));
const featureFlags = vi.hoisted(() => ({
  get: vi.fn(async () => ({ success: true, data: { flags: { ...serverFlags } } })),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { agents, workspaces, featureFlags },
}));

import {
  ServiceGrantsRow,
  ServiceGrantsSettingsSection,
} from '@renderer/features/locations/components/settings-view/sections/service-grants-settings-section';

const GITHUB = {
  status: 'connected' as const,
  login: 'ada-gh',
  install_url: 'https://github.com/apps/example/installations/new',
  installations: [
    {
      id: 7,
      account: 'example-org',
      repositories: [
        { id: 70, name: 'example-org/project' },
        { id: 71, name: 'example-org/docs' },
      ],
    },
  ],
};

const GRANTED: ServiceGrants = {
  grants: [
    {
      service: 'github',
      name: 'GitHub',
      access: 'write',
      resources: { installation_id: 7, repository_ids: [70] },
      summary: 'helper can read and push to 1 repository, acting as the GitHub App.',
    },
  ],
  addressing_open: true,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  for (const mock of [agents.getAgents, ...Object.values(workspaces)]) mock.mockReset();
  serverFlags.service_connections = true;
  agents.getAgents.mockResolvedValue([
    {
      id: 'local-agent',
      name: 'helper',
      workspaceId: 'workspace',
      serverId: 'server',
      switchAgentId: 'agent',
    },
  ]);
  workspaces.getGitHubConnection.mockResolvedValue(GITHUB);
  workspaces.getServiceConnections.mockResolvedValue([]);
  workspaces.setServiceGrant.mockResolvedValue(null);
  workspaces.removeServiceGrant.mockResolvedValue(null);
  workspaces.updateAddressingPolicy.mockResolvedValue(undefined);
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
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <ServiceGrantsSettingsSection locationId="location" agentId="local-agent" />
      </QueryClientProvider>
    )
  );
  return container;
}

function button(within: ParentNode, name: string): HTMLButtonElement | undefined {
  return [...within.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === name
  );
}

it('shows each grant with its repositories and what a GitHub grant means', async () => {
  workspaces.getServiceGrants.mockResolvedValue(GRANTED);
  const el = await render();

  await vi.waitFor(() => expect(el.textContent).toContain(GRANTED.grants[0]!.summary));
  await vi.waitFor(() => expect(el.textContent).toContain('example-org/project'));
  expect(el.textContent).toContain('show as the Switch GitHub App');
  expect(el.textContent).toContain('Not available on Windows yet');
  expect(workspaces.getServiceGrants).toHaveBeenCalledWith({
    workspaceId: 'workspace',
    agentId: 'agent',
  });
});

it('makes the agent owner-only from the warning', async () => {
  workspaces.getServiceGrants.mockResolvedValue(GRANTED);
  const el = await render();

  await vi.waitFor(() => expect(button(el, 'Make owner-only')).toBeDefined());
  await act(async () => button(el, 'Make owner-only')!.click());
  await vi.waitFor(() =>
    expect(workspaces.updateAddressingPolicy).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      agentId: 'agent',
      policy: OWNER_ONLY_POLICY,
    })
  );
});

it('says what removing a grant does, and does not, on your computer', async () => {
  workspaces.getServiceGrants.mockResolvedValue(GRANTED);
  const el = await render();

  await vi.waitFor(() => expect(button(el, 'Remove')).toBeDefined());
  expect(button(el, 'Remove')!.title).toContain('may still use your own sign-in');
  await act(async () => button(el, 'Remove')!.click());
  await vi.waitFor(() =>
    expect(el.textContent).toContain('Removing a grant stops Switch giving this access.')
  );
  expect(workspaces.removeServiceGrant).toHaveBeenCalledWith({
    workspaceId: 'workspace',
    agentId: 'agent',
    service: 'github',
  });
});

it('grants GitHub on the repositories picked, for reading unless asked', async () => {
  workspaces.getServiceGrants.mockResolvedValue({
    grants: [],
    addressing_open: false,
  });
  const el = await render();

  await vi.waitFor(() => expect(el.querySelector('[aria-label="GitHub account"]')).not.toBeNull());
  await act(async () => el.querySelector<HTMLElement>('[aria-label="GitHub account"]')!.click());
  await vi.waitFor(() =>
    expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0)
  );
  const account = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (option) => option.textContent?.trim() === 'example-org'
  );
  await act(async () => account!.click());
  await vi.waitFor(() => expect(el.textContent).toContain('docs'));

  const docs = [...el.querySelectorAll('label')].find((label) =>
    label.textContent?.includes('docs')
  );
  await act(async () => docs!.querySelector<HTMLElement>('[role="checkbox"], button')!.click());
  expect(button(el, 'Grant')?.disabled).toBe(false);
  await act(async () => button(el, 'Grant')!.click());

  await vi.waitFor(() =>
    expect(workspaces.setServiceGrant).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      agentId: 'agent',
      service: 'github',
      access: 'read',
      resources: { installation_id: 7, repository_ids: [71] },
    })
  );
});

it('draws nothing for someone who does not own the agent', async () => {
  workspaces.getServiceGrants.mockResolvedValue(null);
  const el = await render();

  await vi.waitFor(() => expect(workspaces.getServiceGrants).toHaveBeenCalled());
  await act(async () => {});
  expect(el.textContent).toBe('');
});

it('draws nothing, and asks nothing, where the server has service connections off', async () => {
  serverFlags.service_connections = false;
  workspaces.getServiceGrants.mockResolvedValue({
    grants: [],
    addressing_open: false,
  });
  const el = await render();

  await vi.waitFor(() => expect(featureFlags.get).toHaveBeenCalledWith('server'));
  await act(async () => {});
  expect(el.textContent).toBe('');
  expect(workspaces.getServiceGrants).not.toHaveBeenCalled();
});

it('says so when the grants could not be loaded', async () => {
  workspaces.getServiceGrants.mockRejectedValue(new Error('Switch gateway returned 500'));
  const el = await render();

  await vi.waitFor(() => expect(el.textContent).toContain('Switch gateway returned 500'));
});

it("reads the GitHub connection of the agent's own workspace", async () => {
  workspaces.getServiceGrants.mockResolvedValue(GRANTED);
  await render();

  await vi.waitFor(() => expect(workspaces.getGitHubConnection).toHaveBeenCalledWith('workspace'));
});

it("says only what applies to a cloud agent's GitHub grant", async () => {
  workspaces.getServiceGrants.mockResolvedValue(GRANTED);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <ServiceGrantsRow
          serverId="server"
          workspaceId="workspace"
          agentId="agent"
          agentName="reviewer"
          cloud
        />
      </QueryClientProvider>
    )
  );

  await vi.waitFor(() => expect(container!.textContent).toContain(GRANTED.grants[0]!.summary));
  expect(container!.textContent).toContain('show as the Switch GitHub App');
  expect(container!.textContent).not.toContain('Not available on Windows yet');
  expect(container!.textContent).not.toContain('On your computer');
});

function onOff(
  status: ConnectionCatalogEntry['status'],
  overrides: Partial<ConnectionCatalogEntry> = {}
): ConnectionCatalogEntry {
  return {
    slug: 'example',
    name: 'Example',
    category: 'Project management',
    description: 'Example work items.',
    enabled: true,
    auth_type: 'oauth',
    connectable: true,
    status,
    unavailable_reason: null,
    pass_through: true,
    token_lifetime: 3600,
    loopback_ports: null,
    key: null,
    external_identity: null,
    ...overrides,
  };
}

function exampleSwitch(el: HTMLElement): HTMLElement | null {
  return el.querySelector<HTMLElement>('[aria-label="Example for helper"]');
}

it('turns a connected on/off service on with no level to choose', async () => {
  workspaces.getServiceGrants.mockResolvedValue({
    grants: [],
    addressing_open: false,
  });
  workspaces.getServiceConnections.mockResolvedValue([onOff('connected')]);
  const el = await render();

  await vi.waitFor(() => expect(exampleSwitch(el)).not.toBeNull());
  expect(el.textContent).toContain('Off');
  expect(el.textContent).toContain('helper acts as you at Example');
  expect(el.textContent).toContain('within a minute');
  expect(el.textContent).not.toContain('stays valid at Example');
  await act(async () => exampleSwitch(el)!.click());
  await vi.waitFor(() =>
    expect(workspaces.setServiceGrant).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      agentId: 'agent',
      service: 'example',
      access: null,
      resources: {},
    })
  );
  expect(workspaces.getServiceConnections).toHaveBeenCalledWith('workspace');
});

it('turns an on/off grant off, and says a longer-lived token outlasts it', async () => {
  workspaces.getServiceGrants.mockResolvedValue({
    grants: [
      {
        service: 'example',
        name: 'Example',
        access: 'write',
        resources: {},
        summary: 'helper reads and writes Example as you.',
      },
    ],
    addressing_open: false,
  });
  workspaces.getServiceConnections.mockResolvedValue([
    onOff('connected', { token_lifetime: 24 * 3600 }),
  ]);
  const el = await render();

  await vi.waitFor(() =>
    expect(el.textContent).toContain('helper reads and writes Example as you.')
  );
  expect(el.textContent).toContain('stays valid at Example until it expires or you disconnect');
  // Its grant is the switch, not a card with Change and Remove.
  expect(button(el, 'Remove')).toBeUndefined();
  await act(async () => exampleSwitch(el)!.click());
  await vi.waitFor(() =>
    expect(workspaces.removeServiceGrant).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      agentId: 'agent',
      service: 'example',
    })
  );
});

it('cannot turn on a service that is not connected, or not available, and says why', async () => {
  workspaces.getServiceGrants.mockResolvedValue({
    grants: [],
    addressing_open: false,
  });
  workspaces.getServiceConnections.mockResolvedValue([
    onOff('not_connected'),
    onOff('connected', {
      slug: 'other',
      name: 'Other',
      unavailable_reason: 'Switched off on this server.',
    }),
  ]);
  const el = await render();

  await vi.waitFor(() => expect(exampleSwitch(el)).not.toBeNull());
  expect(exampleSwitch(el)!.getAttribute('aria-disabled') ?? '').not.toBe('false');
  expect(el.textContent).toContain("first connect it from the server's Connections");
  expect(el.textContent).toContain('Switched off on this server.');
  await act(async () => exampleSwitch(el)!.click());
  await act(async () => el.querySelector<HTMLElement>('[aria-label="Other for helper"]')!.click());
  expect(workspaces.setServiceGrant).not.toHaveBeenCalled();
});

it('says a key service is used with the owner’s key, and nothing of tokens expiring', async () => {
  workspaces.getServiceGrants.mockResolvedValue({
    grants: [],
    addressing_open: false,
  });
  workspaces.getServiceConnections.mockResolvedValue([
    onOff('connected', {
      auth_type: 'api_key',
      token_lifetime: 24 * 3600,
      key: {
        fields: [{ name: 'api_key', label: 'API key', secret: true, help: null, choices: null }],
        help_url: null,
      },
    }),
  ]);
  const el = await render();

  await vi.waitFor(() => expect(exampleSwitch(el)).not.toBeNull());
  expect(el.textContent).toContain(
    'On, helper uses Example with your key, as far as the key allows. Turning it off stops its sessions using Example within a minute.'
  );
  expect(el.textContent).not.toContain('token');
  expect(el.textContent).not.toContain('expires');
});
