/**
 * Editing a cloud agent: the name and icon go to the agent, the instructions
 * and model to the launch, which the agent runs from its next restart. Only
 * what changed is sent, and a refusal is shown rather than closing the dialog.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CloudLaunch } from '@shared/core/cloud-agents/cloud-agents';

const switchServers = vi.hoisted(() => ({
  getCloudLaunchConfiguration: vi.fn(),
  updateCloudLaunchConfiguration: vi.fn(),
}));
const workspaces = vi.hoisted(() => ({
  listAgents: vi.fn(),
  updateAgentDisplayName: vi.fn(),
  updateAgentIcon: vi.fn(),
}));
const agents = vi.hoisted(() => ({
  definitionFields: vi.fn(),
  modelCatalogue: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers, workspaces, agents },
}));
// The server's workspace in scope: the agent and its name and icon live there.
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {
    idOnServerInScope: (serverId: string | null) => (serverId === 'server' ? 'workspace' : null),
  },
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast }));
vi.mock('@renderer/lib/ui/dialog', () => {
  const Plain = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    DialogHeader: Plain,
    DialogTitle: Plain,
    DialogContentArea: Plain,
    DialogFooter: Plain,
  };
});
vi.mock('@renderer/lib/ui/confirm-button', () => ({
  ConfirmButton: (props: { children: ReactNode; onClick: () => void; disabled: boolean }) => (
    <button onClick={props.onClick} disabled={props.disabled}>
      {props.children}
    </button>
  ),
}));
vi.mock('@renderer/lib/components/agent-icon-picker', () => ({
  AgentIconPicker: (props: { onChange: (url: string | null) => void }) => (
    <button onClick={() => props.onChange('https://icons.example.com/new.png')}>Pick icon</button>
  ),
}));
vi.mock(
  '@renderer/features/locations/components/settings-view/sections/addressing-policy-settings-section',
  () => ({ AddressingPolicyRow: () => <div>Who can talk to your agent</div> })
);
vi.mock(
  '@renderer/features/locations/components/settings-view/sections/service-grants-settings-section',
  () => ({
    ServiceGrantsRow: (props: { agentId: string; cloud: boolean }) => (
      <div>
        Service access for {props.agentId}
        {props.cloud ? ' in the cloud' : ''}
      </div>
    ),
  })
);

import { EditCloudAgentModal } from '@renderer/features/cloud-agents/edit-cloud-agent-modal';

const MODEL = { key: 'model', label: 'Model', type: 'string' as const };

function launch(provider: CloudLaunch['provider']): CloudLaunch {
  return {
    request_id: '00000000-0000-4000-8000-000000000001',
    name: 'reviewer',
    provider,
    state: 'ready',
    desired_state: 'running',
    revision: 4,
    agent_id: 'agent',
    error: null,
    error_code: null,
    sleeping: false,
    machine_id: null,
    process_state: null,
    process_restarts: 0,
    oom_kills: 0,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const onSuccess = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  for (const fn of [
    ...Object.values(switchServers),
    ...Object.values(workspaces),
    ...Object.values(agents),
    toast,
  ])
    fn.mockReset();
  onSuccess.mockReset();
  onClose.mockReset();
  workspaces.listAgents.mockResolvedValue([
    { id: 'agent', name: 'reviewer', displayName: 'Reviewer', iconUrl: null },
  ]);
  switchServers.getCloudLaunchConfiguration.mockResolvedValue({
    description: 'Reviews pull requests',
    instructions: 'Be brief.',
    definition_attributes: { model: 'opus' },
  });
  agents.definitionFields.mockResolvedValue([MODEL]);
  agents.modelCatalogue.mockResolvedValue({ kind: 'unavailable', reason: 'not asked' });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(provider: CloudLaunch['provider']) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <EditCloudAgentModal
          serverId="server"
          launch={launch(provider)}
          onSuccess={onSuccess}
          onClose={onClose}
        />
      </QueryClientProvider>
    )
  );
  await settle();
  await settle();
}

async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll('button')].find((b) =>
    b.textContent?.trim().startsWith(label)
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

async function click(label: string) {
  await act(async () => button(label).click());
  await settle();
}

it('sends a changed name and instructions, keeping the model, and says when they apply', async () => {
  await render('claude');
  expect(container!.textContent).toContain('apply when the agent restarts');

  await type(container!.querySelector('input')!, 'Code Reviewer');
  await type(container!.querySelector('textarea')!, 'Review carefully.');
  await click('Save');

  expect(workspaces.updateAgentDisplayName).toHaveBeenCalledWith({
    workspaceId: 'workspace',
    agentId: 'agent',
    displayName: 'Code Reviewer',
  });
  expect(workspaces.updateAgentIcon).not.toHaveBeenCalled();
  expect(switchServers.updateCloudLaunchConfiguration).toHaveBeenCalledWith(
    'server',
    '00000000-0000-4000-8000-000000000001',
    {
      provider: 'claude',
      name: 'reviewer',
      description: 'Reviews pull requests',
      instructions: 'Review carefully.',
      definition_attributes: { model: 'opus' },
    }
  );
  expect(toast).toHaveBeenCalled();
  expect(onSuccess).toHaveBeenCalled();
});

it("shows the agent's Service access, as a cloud agent's", async () => {
  await render('claude');
  expect(container!.textContent).toContain('Service access for agent in the cloud');
});

it('sends only the icon when only the icon changed', async () => {
  await render('claude');

  await click('Pick icon');
  await click('Save');

  expect(workspaces.updateAgentIcon).toHaveBeenCalledWith({
    workspaceId: 'workspace',
    agentId: 'agent',
    iconUrl: 'https://icons.example.com/new.png',
  });
  expect(workspaces.updateAgentDisplayName).not.toHaveBeenCalled();
  expect(switchServers.updateCloudLaunchConfiguration).not.toHaveBeenCalled();
  expect(onSuccess).toHaveBeenCalled();
});

it('shows a refusal and stays open', async () => {
  switchServers.updateCloudLaunchConfiguration.mockRejectedValue(
    new Error('This worker has been removed.')
  );
  await render('claude');

  await type(container!.querySelector('textarea')!, 'Review carefully.');
  await click('Save');

  expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
    'This worker has been removed.'
  );
  expect(onSuccess).not.toHaveBeenCalled();
});

it('offers no model for a provider whose cloud launch takes none', async () => {
  await render('codex');

  expect(container!.textContent).not.toContain('Advanced configuration');
  await type(container!.querySelector('textarea')!, 'Review carefully.');
  await click('Save');

  expect(switchServers.updateCloudLaunchConfiguration).toHaveBeenCalledWith(
    'server',
    '00000000-0000-4000-8000-000000000001',
    expect.objectContaining({ provider: 'codex', definition_attributes: { model: 'opus' } })
  );
});
