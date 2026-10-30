/**
 * The decision model on a machine's card: "running for auto-route" (or where
 * it stands) when the workspace runs auto-route on that machine, Stop after a
 * confirmation (the workspace back to the server default), and on this
 * computer "Remove downloaded model", which also asks this computer's
 * controller to delete it, saying so when the controller can't. Plus the
 * Settings toggle "Let this computer run the decision model".
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ManagedAgentView, OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import type {
  DecisionEffectiveMachine,
  DecisionSettings,
} from '@shared/core/switch-servers/switch-servers';

const switchServers = vi.hoisted(() => ({
  getDecisionSettings: vi.fn(),
  clearDecisionSettings: vi.fn(),
}));
const embeddedController = vi.hoisted(() => ({
  removeDecisionModel: vi.fn(),
  getDecisionModelEnabled: vi.fn(),
  setDecisionModelEnabled: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers, embeddedController },
}));

import { MachineDecisionModel } from '@renderer/features/managed-agents/machine-decision-model';
import { MachineCard } from '@renderer/features/managed-agents/managed-machine-card';
import { ThisComputerDecisionModelRow } from '@renderer/features/managed-agents/this-computer-decision-model-row';

const SERVER_DEFAULT: DecisionSettings = {
  source: 'server_default',
  effective: {
    backend: 'endpoint',
    endpoint: 'http://decision:8230',
    threshold: null,
    available: true,
    reason: null,
    machine: null,
  },
  workspace: null,
  serverDefault: { configured: true, endpoint: 'http://decision:8230', hasApiKey: false },
  options: { haikuAnthropic: false, haikuBedrock: false, machines: [] },
};

function onMac(machine: Partial<DecisionEffectiveMachine> = {}): DecisionSettings {
  return {
    ...SERVER_DEFAULT,
    source: 'workspace',
    effective: {
      backend: 'machine',
      endpoint: null,
      threshold: null,
      available: true,
      reason: null,
      machine: {
        id: 'ctl-mac',
        name: 'Mac-Studio',
        model: 'qwen3.5-4b-q4_k_m',
        state: 'running',
        progress: null,
        ready: true,
        reason: null,
        lastDecisionMs: 480,
        connected: true,
        since: null,
        ...machine,
      },
    },
    workspace: {
      backend: 'machine',
      endpoint: null,
      threshold: null,
      hasApiKey: false,
      apiKeyLast4: null,
      apiKeyUnreadable: false,
      updatedAt: '2026-10-29T10:00:00Z',
      machineId: 'ctl-mac',
      model: 'qwen3.5-4b-q4_k_m',
    },
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  for (const mock of [...Object.values(switchServers), ...Object.values(embeddedController)])
    mock.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mount(node: ReactNode): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
  );
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
  return container;
}

async function renderCard(
  settings: DecisionSettings | { kind: string },
  { thisComputer = true, machineId = 'ctl-mac' } = {}
): Promise<HTMLElement> {
  switchServers.getDecisionSettings.mockResolvedValue(
    'kind' in settings ? settings : { kind: 'loaded', settings }
  );
  const el = await mount(
    <MachineDecisionModel
      workspaceId="ws-1"
      serverId="srv-1"
      machineId={machineId}
      thisComputer={thisComputer}
    />
  );
  await vi.waitFor(() => expect(switchServers.getDecisionSettings).toHaveBeenCalledWith('ws-1'));
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
  return el;
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text
  );
  if (!found) throw new Error(`no button ${text}`);
  return found;
}

function hasButton(el: HTMLElement, text: string): boolean {
  return [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === text);
}

function status(el: HTMLElement): string | null {
  return el.querySelector('[aria-label="Decision model"] [role="status"]')?.textContent ?? null;
}

it('says the machine runs the decision model for auto-route, with Stop and Remove', async () => {
  const el = await renderCard(onMac());
  expect(status(el)).toBe('Decision model: running for auto-route');
  expect(hasButton(el, 'Stop')).toBe(true);
  expect(hasButton(el, 'Remove downloaded model')).toBe(true);
});

it('says where the model stands while it is not running', async () => {
  const el = await renderCard(
    onMac({
      state: 'downloading',
      ready: false,
      progress: { doneBytes: 1_200_000_000, totalBytes: 2_700_000_000 },
    })
  );
  expect(status(el)).toBe('Decision model for auto-route: Downloading 1.2 / 2.7 GB');
});

it('offers Remove on this computer only', async () => {
  const el = await renderCard(onMac(), { thisComputer: false });
  expect(hasButton(el, 'Stop')).toBe(true);
  expect(hasButton(el, 'Remove downloaded model')).toBe(false);
});

it('shows nothing for a machine the workspace doesn’t use, or for someone who isn’t its admin', async () => {
  const other = await renderCard(onMac(), { machineId: 'ctl-other' });
  expect(other.querySelector('[aria-label="Decision model"]')).toBeNull();
  await act(async () => root!.unmount());
  root = null;
  container?.remove();

  const serverDefault = await renderCard(SERVER_DEFAULT);
  expect(serverDefault.querySelector('[aria-label="Decision model"]')).toBeNull();
  await act(async () => root!.unmount());
  root = null;
  container?.remove();

  const member = await renderCard({ kind: 'forbidden' });
  expect(member.querySelector('[aria-label="Decision model"]')).toBeNull();
});

it('stops it after a confirmation, returning the workspace to the server default', async () => {
  switchServers.clearDecisionSettings.mockResolvedValue({
    kind: 'cleared',
    settings: SERVER_DEFAULT,
  });
  const el = await renderCard(onMac());

  await act(async () => button(el, 'Stop').click());
  expect(switchServers.clearDecisionSettings).not.toHaveBeenCalled();
  expect(el.textContent).toContain('goes back to the server default');
  await act(async () => button(el, 'Cancel').click());
  expect(switchServers.clearDecisionSettings).not.toHaveBeenCalled();

  switchServers.getDecisionSettings.mockResolvedValue({ kind: 'loaded', settings: SERVER_DEFAULT });
  await act(async () => button(el, 'Stop').click());
  await act(async () => button(el, 'Stop').click());
  await vi.waitFor(() => expect(switchServers.clearDecisionSettings).toHaveBeenCalledWith('ws-1'));
  await vi.waitFor(() =>
    expect(el.querySelector('[aria-label="Decision model outcome"]')?.textContent).toBe(
      'Stopped. Auto-route uses the server default; the downloaded model stays.'
    )
  );
  expect(status(el)).toBeNull();
  expect(hasButton(el, 'Stop')).toBe(false);
  expect(embeddedController.removeDecisionModel).not.toHaveBeenCalled();
});

it('says why it could not stop', async () => {
  switchServers.clearDecisionSettings.mockResolvedValue({ kind: 'forbidden' });
  const el = await renderCard(onMac());
  await act(async () => button(el, 'Stop').click());
  await act(async () => button(el, 'Stop').click());
  await vi.waitFor(() =>
    expect(el.textContent).toContain(
      'Only an admin of this workspace can change its decision routing.'
    )
  );
});

it('removes the downloaded model after a confirmation: stops it, then asks the controller', async () => {
  switchServers.clearDecisionSettings.mockResolvedValue({
    kind: 'cleared',
    settings: SERVER_DEFAULT,
  });
  embeddedController.removeDecisionModel.mockResolvedValue(undefined);
  const el = await renderCard(onMac());

  await act(async () => button(el, 'Remove downloaded model').click());
  expect(el.textContent).toContain('remove the downloaded model from this computer');
  await act(async () => button(el, 'Remove').click());

  await vi.waitFor(() =>
    expect(embeddedController.removeDecisionModel).toHaveBeenCalledWith('srv-1')
  );
  expect(switchServers.clearDecisionSettings).toHaveBeenCalledWith('ws-1');
  await vi.waitFor(() =>
    expect(el.querySelector('[aria-label="Decision model outcome"]')?.textContent).toBe(
      'Stopped, and removed the downloaded model.'
    )
  );
});

it('says so when this computer’s controller can’t remove the model', async () => {
  switchServers.clearDecisionSettings.mockResolvedValue({
    kind: 'cleared',
    settings: SERVER_DEFAULT,
  });
  embeddedController.removeDecisionModel.mockRejectedValue(
    new Error(
      'Removing the downloaded model is not supported by this controller version. Update Switch Console to get one that does.'
    )
  );
  const el = await renderCard(onMac());
  await act(async () => button(el, 'Remove downloaded model').click());
  await act(async () => button(el, 'Remove').click());
  await vi.waitFor(() =>
    expect(el.querySelector('[aria-label="Decision model outcome"]')?.textContent).toContain(
      'not supported by this controller version'
    )
  );
});

it('appears on the managed agent’s machine card', async () => {
  switchServers.getDecisionSettings.mockResolvedValue({ kind: 'loaded', settings: onMac() });
  const agent = {
    serverId: 'srv-1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    desiredState: 'running',
    status: { process: 'running', attached: true },
    definition: { provider: 'claude' },
    machine: { id: 'ctl-mac', name: 'Mac-Studio', kind: 'console', state: 'online' },
  } as unknown as ManagedAgentView;
  const machine = {
    id: 'ctl-mac',
    name: 'Mac-Studio',
    providers: [],
    local: { kind: 'this-computer' },
  } as unknown as OwnedMachine;
  const el = await mount(
    <MachineCard agent={agent} machine={machine} machinesLoading={false} machinesError={null} />
  );
  await vi.waitFor(() => expect(status(el)).toBe('Decision model: running for auto-route'));
  expect(hasButton(el, 'Remove downloaded model')).toBe(true);
});

it('lets this computer run the decision model, or turns it off', async () => {
  embeddedController.getDecisionModelEnabled.mockResolvedValue(true);
  embeddedController.setDecisionModelEnabled.mockResolvedValue(undefined);
  const el = await mount(<ThisComputerDecisionModelRow />);
  const toggle = () =>
    el.querySelector<HTMLElement>('[aria-label="Let this computer run the decision model"]')!;
  await vi.waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
  expect(el.textContent).toContain('Let this computer run the decision model');

  embeddedController.getDecisionModelEnabled.mockResolvedValue(false);
  await act(async () => toggle().click());
  await vi.waitFor(() =>
    expect(embeddedController.setDecisionModelEnabled).toHaveBeenCalledWith(false)
  );
  await vi.waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
});

it('says why the toggle could not change', async () => {
  embeddedController.getDecisionModelEnabled.mockResolvedValue(true);
  embeddedController.setDecisionModelEnabled.mockRejectedValue(new Error('Disk is read-only.'));
  const el = await mount(<ThisComputerDecisionModelRow />);
  const toggle = el.querySelector<HTMLElement>(
    '[aria-label="Let this computer run the decision model"]'
  )!;
  await vi.waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  await act(async () => toggle.click());
  await vi.waitFor(() => expect(el.textContent).toContain('Disk is read-only.'));
  await vi.waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
});
