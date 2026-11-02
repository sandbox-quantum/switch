/**
 * V3b, Repair my cloud on the Cloud machine card (design v1.2, the designer's copy): the
 * button only when Core says a repair would be accepted, the confirm with each provider's
 * login line, fixed refusals, and the re-seal's three states.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';

const managedAgents = vi.hoisted(() => ({
  loginSources: vi.fn(),
  repairCloud: vi.fn(),
  resealAfterRepair: vi.fn(),
  machines: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({ events: { on: () => () => {} }, rpc: { managedAgents } }));
vi.mock('@renderer/features/locations/components/add-agent-modal/give-machine-login', () => ({
  GiveMachineLogin: ({ provider }: { provider: string }) => <p>give login for {provider}</p>,
}));

import { RepairCloud } from '@renderer/features/cloud-agents/repair-cloud';

function machine(over: Partial<CloudMachine> = {}): CloudMachine {
  return {
    machine_id: 'm1',
    state: 'ready',
    desired_state: 'running',
    stop_reason: null,
    sleeping: false,
    revision: 5,
    instance_type: 'c7i.2xlarge',
    error: null,
    error_code: null,
    retain_until: null,
    heartbeat_at: '2026-01-01T00:00:00Z',
    disk: { total_bytes: 1, available_bytes: 1 },
    memory: { total_bytes: 1, available_bytes: 1 },
    agents: [],
    controller_id: 'c-old',
    room: null,
    awake: null,
    ai_calls_today: null,
    ...over,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient;

beforeEach(() => {
  for (const fn of Object.values(managedAgents)) fn.mockReset();
  managedAgents.machines.mockResolvedValue([{ id: 'c-new', name: 'cloud' }]);
  managedAgents.loginSources.mockResolvedValue({
    codex: { kind: 'this-computer', label: 'alex@example.com' },
    claude: { kind: 'typed' },
  });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function render(m: CloudMachine): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await rerender(m);
  return container;
}

async function rerender(m: CloudMachine): Promise<void> {
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <RepairCloud machine={m} serverId="server" />
      </QueryClientProvider>
    )
  );
  await settle();
}

function button(el: HTMLElement, name: RegExp): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

it('shows nothing unless Core says a repair would be accepted', async () => {
  const el = await render(machine({ repair_available: false }));
  expect(el.textContent).toBe('');
  expect(managedAgents.resealAfterRepair).not.toHaveBeenCalled();
});

it('confirms with each provider’s login line, then repairs this box', async () => {
  managedAgents.repairCloud.mockResolvedValue(undefined);
  const el = await render(machine({ repair_available: true }));
  expect(el.textContent).toMatch(/Your cloud needs repairing/);
  await act(async () => button(el, /Repair my cloud/)!.click());
  await settle();
  expect(el.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
    'Repair your cloud?'
  );
  expect(el.textContent).toMatch(/Codex: copied from this computer \(alex@example\.com\)/);
  expect(el.textContent).toMatch(/Your AI login is sealed so only your cloud can read it\./);
  expect(el.textContent).toMatch(/Switch doesn't keep pasted keys/);
  await act(async () => button(el, /^Repair$/)!.click());
  await settle();
  expect(managedAgents.repairCloud).toHaveBeenCalledWith({
    serverId: 'server',
    machineId: 'm1',
    controllerId: 'c-old',
  });
});

it('shows the fixed refusal it is given', async () => {
  managedAgents.repairCloud.mockRejectedValue(
    new Error("Switch has paused your cloud, so it can't be repaired. Contact your admin.")
  );
  const el = await render(machine({ repair_available: true }));
  await act(async () => button(el, /Repair my cloud/)!.click());
  await settle();
  await act(async () => button(el, /^Repair$/)!.click());
  await settle();
  expect(el.querySelector('[role="alert"]')?.textContent).toBe(
    "Switch has paused your cloud, so it can't be repaired. Contact your admin."
  );
});

it('asks for a key the re-seal could not copy, with the provider already chosen', async () => {
  managedAgents.resealAfterRepair.mockResolvedValue({ copied: [], asked: ['claude'] });
  const el = await render(machine({ controller_id: 'c-new', reseal_providers: ['claude'] }));
  expect(managedAgents.resealAfterRepair).toHaveBeenCalledTimes(1);
  expect(managedAgents.resealAfterRepair).toHaveBeenCalledWith({
    serverId: 'server',
    machineId: 'm1',
  });
  expect(el.textContent).toMatch(/Your cloud is repaired\. Enter your AI key again/);
  await act(async () => button(el, /Set up AI provider/)!.click());
  await settle();
  expect(el.textContent).toMatch(/give login for claude/);
});

it('says the login is back once the copy is done and Core has cleared the note', async () => {
  managedAgents.resealAfterRepair.mockResolvedValue({ copied: ['codex'], asked: [] });
  const el = await render(machine({ controller_id: 'c-new', reseal_providers: ['codex'] }));
  await rerender(machine({ controller_id: 'c-new', reseal_providers: [] }));
  expect(el.textContent).toBe(
    'Your cloud is repaired and your AI login is back. Your agents can reply again.'
  );
});

it('offers one button per provider still waiting, so each can be set up', async () => {
  managedAgents.resealAfterRepair.mockResolvedValue({ copied: [], asked: ['claude', 'codex'] });
  const el = await render(
    machine({ controller_id: 'c-new', reseal_providers: ['claude', 'codex'] })
  );
  const setUps = [...el.querySelectorAll('button')].filter((b) =>
    /^Set up /.test(b.textContent ?? '')
  );
  expect(setUps).toHaveLength(2);
  await act(async () => setUps[1]!.click());
  await settle();
  expect(el.textContent).toMatch(/give login for codex/);
  // Once Claude is given, Core drops it from the note and only Codex is left.
  await rerender(machine({ controller_id: 'c-new', reseal_providers: ['codex'] }));
  expect(el.textContent).not.toMatch(/give login for claude/);
});

it('clears an old refusal when the confirm is cancelled', async () => {
  managedAgents.repairCloud.mockRejectedValue(
    new Error("The repair didn't go through. Try again in a minute.")
  );
  const el = await render(machine({ repair_available: true }));
  await act(async () => button(el, /Repair my cloud/)!.click());
  await settle();
  await act(async () => button(el, /^Repair$/)!.click());
  await settle();
  expect(el.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => button(el, /^Cancel$/)!.click());
  await settle();
  await act(async () => button(el, /Repair my cloud/)!.click());
  await settle();
  expect(el.querySelector('[role="alert"]')).toBeNull();
});

it('builds the set-up buttons from Core’s current note, not the cached run (QA)', async () => {
  managedAgents.resealAfterRepair.mockResolvedValue({ copied: [], asked: ['claude', 'codex'] });
  const el = await render(
    machine({ controller_id: 'c-new', reseal_providers: ['claude', 'codex'] })
  );
  // Claude given: Core's note now holds Codex only, while the cached run still says both.
  await rerender(machine({ controller_id: 'c-new', reseal_providers: ['codex'] }));
  const setUps = [...el.querySelectorAll('button')].filter((b) =>
    /^Set up /.test(b.textContent ?? '')
  );
  expect(setUps.map((b) => b.textContent)).toEqual(['Set up AI provider']);
  await act(async () => setUps[0]!.click());
  await settle();
  expect(el.textContent).toMatch(/give login for codex/);
  expect(managedAgents.resealAfterRepair).toHaveBeenCalledTimes(1);
});

it('shows no brackets without a label, and a label only ever as plain text', async () => {
  managedAgents.loginSources.mockResolvedValue({
    opencode: { kind: 'this-computer' },
    codex: { kind: 'this-computer', label: '<img src=x onerror=alert(1)>' },
  });
  const el = await render(machine({ repair_available: true }));
  await act(async () => button(el, /Repair my cloud/)!.click());
  await settle();
  expect(el.textContent).toMatch(/OpenCode: copied from this computer(?! \()/);
  expect(el.querySelector('[role="dialog"] img')).toBeNull();
  expect(el.textContent).toContain('(<img src=x onerror=alert(1)>)');
  expect(el.textContent).not.toMatch(/Switch doesn't keep pasted keys/);
});
