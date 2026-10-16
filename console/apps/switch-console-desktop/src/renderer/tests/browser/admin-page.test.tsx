/**
 * The Admin page of the workspace in scope: its sections down the side,
 * under what they reach, and a workspace admin's switch for each service,
 * drawn as tiles. A switch asks before it reaches other people, shows what
 * the server says rather than what was asked, and keeps its place when it
 * flips. Someone who administers nothing is told whom to ask.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkspaceService } from '@shared/core/switch-servers/connection-catalog';

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
const admin = vi.hoisted(() => ({ administers: true }));
/** The confirmations asked for; each is answered by the test. */
const confirmations = vi.hoisted(
  () => [] as { title: string; description: string; onSuccess: () => void }[]
);

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { workspaces, featureFlags },
}));

vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { onServerInScope: () => ({ id: 'workspace', name: 'Acme' }) },
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { servers: [{ id: 'server', name: 'Dev Server' }] },
}));

vi.mock('@renderer/features/switch-servers/workspace-admin', () => ({
  administersWorkspaceInScope: () => admin.administers,
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: () => {} }),
  useParams: () => ({ params: { serverId: 'server' }, setParams: () => {} }),
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: () => (args: (typeof confirmations)[number]) => confirmations.push(args),
}));

import { adminView } from '@renderer/features/admin/admin-view';

function service(overrides: Partial<WorkspaceService>): WorkspaceService {
  return {
    slug: 'example',
    name: 'Example',
    enabled: true,
    updated_by_name: null,
    updated_at: null,
    connected_members: 0,
    granted_agents: 0,
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
  admin.administers = true;
  confirmations.length = 0;
  for (const mock of Object.values(workspaces)) mock.mockReset();
  workspaces.getServiceConnections.mockResolvedValue([]);
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
  const Panel = adminView.MainPanel;
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Panel />
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

it('lists its sections under what they reach, and each service as a tile with who it uses', async () => {
  workspaces.getWorkspaceServices.mockResolvedValue(SERVICES);
  const page = await render();

  await vi.waitFor(() => expect(tiles(page)).not.toBeNull());
  expect(workspaces.getWorkspaceServices).toHaveBeenCalledWith('workspace');
  expect(page.textContent).toContain('Choose which services people in Acme can connect');
  const workspace = page.querySelector('nav [role="group"][aria-label="Workspace"]')!;
  expect(workspace.textContent).toBe('Workspace · AcmeConnectors');
  expect(workspace.querySelector('[aria-current="page"]')!.textContent).toBe('Connectors');
  expect(page.querySelector('nav [role="group"][aria-label="Server"]')).toBeNull();
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
  expect(confirmations[0].description).toBe(
    '3 members are connected and 2 agents use it. Their sessions lose it within a minute.'
  );

  workspaces.getWorkspaceServices.mockResolvedValue([
    { ...SERVICES[0], enabled: false, updated_by_name: 'Ada', updated_at: '2026-10-16T09:00:00Z' },
    SERVICES[1],
  ]);
  await act(async () => confirmations[0].onSuccess());

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

it('tells someone who administers nothing whom to ask, asking the server nothing', async () => {
  admin.administers = false;
  const page = await render();

  await vi.waitFor(() =>
    expect(page.textContent).toContain('Ask a workspace admin to change these.')
  );
  expect(workspaces.getWorkspaceServices).not.toHaveBeenCalled();
});
