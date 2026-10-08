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
import { OWNER_ONLY_POLICY, type ServiceGrants } from '@shared/core/switch-servers/service-grants';

const agents = vi.hoisted(() => ({ getAgents: vi.fn() }));
const workspaces = vi.hoisted(() => ({
  getServiceGrants: vi.fn(),
  getGitHubConnection: vi.fn(),
  setServiceGrant: vi.fn(),
  removeServiceGrant: vi.fn(),
  updateAddressingPolicy: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { agents, workspaces },
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
        { id: 70, name: 'project' },
        { id: 71, name: 'docs' },
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
  missing: [],
  addressing_open: true,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  for (const mock of [agents.getAgents, ...Object.values(workspaces)]) mock.mockReset();
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

it("restores a cloud agent's missing repository grant in one click", async () => {
  workspaces.getServiceGrants.mockResolvedValue({
    grants: [],
    missing: [
      {
        service: 'github',
        reason: 'This cloud agent works in example-org/project, but has no GitHub grant.',
        access: 'write',
        resources: { installation_id: 7, repository_ids: [70] },
      },
    ],
    addressing_open: false,
  });
  const el = await render();

  await vi.waitFor(() => expect(button(el, 'Grant it')).toBeDefined());
  await act(async () => button(el, 'Grant it')!.click());
  await vi.waitFor(() =>
    expect(workspaces.setServiceGrant).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      agentId: 'agent',
      service: 'github',
      access: 'write',
      resources: { installation_id: 7, repository_ids: [70] },
    })
  );
});

it('grants GitHub on the repositories picked, for reading unless asked', async () => {
  workspaces.getServiceGrants.mockResolvedValue({
    grants: [],
    missing: [],
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
        <ServiceGrantsRow workspaceId="workspace" agentId="agent" agentName="reviewer" cloud />
      </QueryClientProvider>
    )
  );

  await vi.waitFor(() => expect(container!.textContent).toContain(GRANTED.grants[0]!.summary));
  expect(container!.textContent).toContain('show as the Switch GitHub App');
  expect(container!.textContent).not.toContain('Not available on Windows yet');
  expect(container!.textContent).not.toContain('On your computer');
});
