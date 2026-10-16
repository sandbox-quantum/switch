/**
 * A managed agent's page is the Console agent page, fed from its server: the
 * header, instructions, General, the server's Advanced configuration for its
 * provider and its sessions. Every edit is pending until the page's save bar
 * saves them together, sending only what changed; a refusal is shown in the
 * server's words. Its tabbed titlebar keeps every tab in view beside a long
 * name.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  ManagedAgentView,
  ManagedMachine,
  OwnedMachine,
} from '@shared/core/managed-agents/managed-agents';

const managedAgents = vi.hoisted(() => ({
  machines: vi.fn(),
  update: vi.fn(),
  advancedConfigSchema: vi.fn(),
}));
const workspaces = vi.hoisted(() => ({
  updateAgentDisplayName: vi.fn(),
  updateAgentDescription: vi.fn(),
  updateAgentIcon: vi.fn(),
}));
const modelCatalogue = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { managedAgents, workspaces, agents: { modelCatalogue } },
}));
vi.mock(
  '@renderer/features/locations/components/settings-view/sections/addressing-policy-settings-section',
  () => ({ AddressingPolicyRow: () => <div>Who can talk to your agent</div> })
);
vi.mock(
  '@renderer/features/locations/components/settings-view/sections/can-manage-agents-settings-section',
  () => ({ CanManageAgentsRow: () => <div>Can manage agents</div> })
);
vi.mock(
  '@renderer/features/locations/components/settings-view/sections/service-grants-settings-section',
  () => ({
    ServiceGrantsRow: (props: {
      workspaceId: string;
      agentId: string;
      agentName: string;
      cloud: boolean;
    }) => (
      <div data-testid="service-grants">
        Service access for {props.agentName} ({props.agentId} in {props.workspaceId}
        {props.cloud ? ', cloud' : ''})
      </div>
    ),
  })
);
vi.mock('@renderer/lib/components/agent-icon-picker', () => ({ AgentIconPicker: () => null }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => vi.fn() }));

import '@renderer/index.css';
import { agentTabs } from '@renderer/features/managed-agents/agent-tabs';
import { ManagedAgentPage } from '@renderer/features/managed-agents/managed-agent-page';
import { TabbedAgentTitlebar } from '@renderer/features/managed-agents/tabbed-agent-titlebar';
import { TitlebarBreadcrumb } from '@renderer/lib/components/titlebar/titlebar-breadcrumb';
import { WorkspaceLayoutContextProvider } from '@renderer/lib/layout/layout-provider';

const AGENT: ManagedAgentView = {
  serverId: 'server-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  name: 'pm-agent',
  displayName: null,
  iconUrl: null,
  description: 'Writes PRDs',
  machine: { id: 'controller-1', name: 'laptop', kind: 'console', state: 'online' },
  desiredState: 'running',
  revision: 1,
  definition: {
    provider: 'claude',
    model: 'opus',
    advancedConfig: { effort: 'high', tools: ['Read'] },
    instructions: 'Be brief.',
    autoApprove: false,
    directory: '/work/pm',
    isolation: 'shared',
  },
  status: { process: 'running', attached: true, reason: null, detail: null, directory: null },
};

const LAPTOP: OwnedMachine = {
  ...AGENT.machine!,
  local: { kind: 'this-computer' },
  providers: [{ provider: 'claude', ready: true, problem: null }],
  acceptsLogins: false,
  cloud: false,
  workspacesDir: '/home/me/workspaces',
  os: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  managedAgents.machines.mockReset().mockResolvedValue([LAPTOP]);
  managedAgents.update.mockReset().mockResolvedValue(undefined);
  managedAgents.advancedConfigSchema.mockReset().mockResolvedValue({
    claude: [
      {
        key: 'effort',
        label: 'Effort',
        type: 'select',
        options: [
          { value: '', label: 'Inherit' },
          { value: 'high', label: 'high' },
        ],
      },
      { key: 'tools', label: 'Tools', type: 'list' },
    ],
  });
  for (const fn of Object.values(workspaces)) fn.mockReset().mockResolvedValue(undefined);
  modelCatalogue
    .mockReset()
    .mockResolvedValue({ kind: 'available', models: [{ id: 'opus', variants: [] }] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ManagedAgentPage agent={AGENT} serviceGrants />
      </QueryClientProvider>
    );
  });
  await vi.waitFor(() => expect(disclosure().textContent).toMatch(/3 settings/));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(name: RegExp): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) =>
    name.test(b.textContent?.trim() ?? '')
  );
}

function disclosure(): HTMLButtonElement {
  const found = button(/^Advanced configuration/);
  if (!found) throw new Error('no Advanced configuration row');
  return found;
}

async function type(target: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function editAdvancedAndDescription() {
  await act(async () => disclosure().click());
  await type(container.querySelector<HTMLInputElement>('#agent-definition-tools')!, 'Read, Grep');
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click()
  );
  await type(
    container.querySelector<HTMLInputElement>('input[aria-label="Description"]')!,
    'Writes specs'
  );
}

it('lays out the agent the way a Console agent’s page does', () => {
  const text = container.textContent ?? '';
  expect(container.querySelector('h1')?.textContent).toBe('pm-agent');
  expect(text).toContain('Claude Code');
  expect(text).toContain('on laptop');
  expect(text).toContain('Writes PRDs');
  expect(container.querySelector('textarea')?.value).toBe('Be brief.');
  for (const heading of ['General', 'Sessions'])
    expect([...container.querySelectorAll('h2')].map((h) => h.textContent)).toContain(heading);
  for (const row of [
    'Auto-create a session on notify',
    'Bypass permissions',
    'Can manage agents',
    'Who can talk to your agent',
    'Service access for pm-agent (agent-1 in workspace-1)',
    'Directory',
    'Run in its own process',
  ])
    expect(text).toContain(row);
  expect(container.querySelector('[title="/work/pm"]')?.textContent).toBe('/work/pm');
  expect(text).not.toContain('Chosen by the machine');
  expect(disclosure().textContent).toContain('opus · high');
  expect(text).not.toContain('Unsaved changes');
});

it('shows the model first, then the server’s fields for the provider', async () => {
  await act(async () => disclosure().click());
  const labels = [...container.querySelectorAll('label')].map((label) => label.textContent);
  expect(labels.slice(1, 4)).toEqual(['Model (optional)', 'Effort (optional)', 'Tools (optional)']);
  expect(modelCatalogue).toHaveBeenCalledWith({
    providerId: 'claude',
    sshHost: null,
    dir: '/work/pm',
  });
});

it('saves an advanced field and the description together from the save bar, sending only what changed', async () => {
  await editAdvancedAndDescription();
  expect(container.textContent).toContain('Unsaved changes');
  await act(async () => button(/^Save/)!.click());
  expect(managedAgents.update).toHaveBeenCalledWith({
    serverId: 'server-1',
    agentId: 'agent-1',
    changes: { definition: { advancedConfig: { effort: 'high', tools: ['Read', 'Grep'] } } },
  });
  expect(workspaces.updateAgentDescription).toHaveBeenCalledWith({
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    description: 'Writes specs',
  });
  expect(workspaces.updateAgentDisplayName).not.toHaveBeenCalled();
  expect(workspaces.updateAgentIcon).not.toHaveBeenCalled();
});

it('shows the server’s refusal, and saves nothing else', async () => {
  managedAgents.update.mockRejectedValue(new Error('Claude Code is not installed on laptop.'));
  await editAdvancedAndDescription();
  await act(async () => button(/^Save/)!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Claude Code is not installed on laptop.'
  );
  expect(workspaces.updateAgentDescription).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Unsaved changes');
});

it('saves where and how the agent runs from General, with the other definition edits', async () => {
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Run in its own process"]')!.click()
  );
  expect(container.textContent).toContain('Unsaved changes');
  await act(async () => button(/^Save/)!.click());
  expect(managedAgents.update).toHaveBeenCalledWith({
    serverId: 'server-1',
    agentId: 'agent-1',
    changes: { definition: { isolation: 'isolated' } },
  });
});

it('shows where the machine will make the agent’s directory when nothing names one', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ManagedAgentPage
          key="unplaced"
          serviceGrants
          agent={{ ...AGENT, definition: { ...AGENT.definition, directory: null } }}
        />
      </QueryClientProvider>
    );
  });
  await vi.waitFor(() =>
    expect(container.querySelector('[title="/home/me/workspaces/pm-agent"]')).not.toBeNull()
  );
});

it('gives an agent on the Switch cloud machine the cloud agent’s service access', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const machine: ManagedMachine = {
    id: 'controller-2',
    name: 'Switch cloud',
    kind: 'ec2',
    state: 'online',
  };
  managedAgents.machines.mockResolvedValue([{ ...LAPTOP, ...machine, local: null, cloud: true }]);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ManagedAgentPage key="cloud" agent={{ ...AGENT, machine }} serviceGrants />
      </QueryClientProvider>
    );
  });
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="service-grants"]')?.textContent).toBe(
      'Service access for pm-agent (agent-1 in workspace-1, cloud)'
    )
  );
});

it('keeps Chats, Connections and Settings in view beside a long name, on every tab', async () => {
  const tabs = agentTabs(true, undefined);
  expect(tabs.map((tab) => tab.label)).toEqual(['Chats', 'Connections', 'Settings']);
  for (const shown of tabs) {
    const host = document.createElement('div');
    host.style.width = '900px';
    document.body.appendChild(host);
    const titleRoot = createRoot(host);
    await act(async () =>
      titleRoot.render(
        <WorkspaceLayoutContextProvider>
          <TabbedAgentTitlebar
            breadcrumb={
              <TitlebarBreadcrumb crumbs={[{ key: 'agent', label: 'm3-managed-reviewer' }]} />
            }
            tab={shown.value}
            tabs={tabs}
            onTab={() => {}}
            rightSlot={null}
          />
        </WorkspaceLayoutContextProvider>
      )
    );
    const control = host.querySelector<HTMLElement>('[aria-label="Agent view"]')!;
    const side = control.parentElement!.parentElement!.getBoundingClientRect();
    for (const { label } of tabs) {
      const item = control.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
      const box = item.getBoundingClientRect();
      expect(box.width, `${label} on ${shown.label}`).toBeGreaterThan(0);
      expect(item.scrollWidth, `${label} on ${shown.label}`).toBeLessThanOrEqual(item.clientWidth);
      expect(box.right, `${label} on ${shown.label}`).toBeLessThanOrEqual(side.right + 0.5);
    }
    expect(host.textContent).toContain('m3-managed-reviewer');
    act(() => titleRoot.unmount());
    host.remove();
  }
});
