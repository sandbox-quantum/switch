/**
 * Decision routing's "Run on one of my machines": the picker of the admin's
 * own machines (one that can't run the model listed but not choosable, with
 * the reason; one not connected flagged), the model select from the
 * machine's offer, save and test with the machine and model, and the state
 * line for every state the machine reports, asked again while it settles.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  DecisionEffectiveMachine,
  DecisionMachineOption,
  DecisionSettings,
} from '@shared/core/switch-servers/switch-servers';

const switchServers = vi.hoisted(() => ({
  getDecisionSettings: vi.fn(),
  updateDecisionSettings: vi.fn(),
  clearDecisionSettings: vi.fn(),
  testDecisionSettings: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers },
}));

import { MACHINE_POLL_MS } from '@renderer/features/admin/decision-routing';
import { DecisionRoutingSection } from '@renderer/features/admin/decision-routing-section';

const QWEN = {
  model: 'qwen3.5-4b-q4_k_m',
  label: 'Qwen3.5-4B',
  kind: 'llamacpp',
  runtime: 'llamacpp-metal',
  downloadBytes: 2_700_000_000,
  speed: 'fast' as const,
};

const MAC: DecisionMachineOption = {
  id: 'ctl-mac',
  name: 'Mac-Studio',
  connected: true,
  decision: {
    supported: true,
    hardware: {
      accelerator: 'apple_silicon',
      memoryBytes: 64_000_000_000,
      gpuName: null,
      vramBytes: null,
    },
    offered: [QWEN],
    reason: null,
  },
};

const LAPTOP: DecisionMachineOption = {
  ...MAC,
  id: 'ctl-laptop',
  name: 'travel-laptop',
  connected: false,
};

const OLD_BOX: DecisionMachineOption = {
  id: 'ctl-old',
  name: 'old-box',
  connected: true,
  decision: {
    supported: false,
    hardware: null,
    offered: [],
    reason: 'Update this machine’s controller',
  },
};

const SERVER_DEFAULT: DecisionSettings = {
  source: 'server_default',
  effective: {
    backend: 'none',
    endpoint: null,
    threshold: null,
    available: false,
    reason: 'Auto-route needs a decision service.',
    machine: null,
  },
  workspace: null,
  serverDefault: { configured: false, endpoint: null, hasApiKey: false },
  options: { haikuAnthropic: false, haikuBedrock: false, machines: [MAC, LAPTOP, OLD_BOX] },
};

function onMac(machine: Partial<DecisionEffectiveMachine> = {}): DecisionSettings {
  const effective: DecisionEffectiveMachine = {
    id: 'ctl-mac',
    name: 'Mac-Studio',
    model: 'qwen3.5-4b-q4_k_m',
    state: 'running',
    progress: null,
    ready: true,
    reason: null,
    lastDecisionMs: null,
    connected: true,
    since: null,
    ...machine,
  };
  return {
    ...SERVER_DEFAULT,
    source: 'workspace',
    effective: {
      backend: 'machine',
      endpoint: null,
      threshold: null,
      available: effective.state === 'running',
      reason: null,
      machine: effective,
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
  for (const mock of Object.values(switchServers)) mock.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
}

async function render(settings: DecisionSettings): Promise<HTMLElement> {
  switchServers.getDecisionSettings.mockResolvedValue({ kind: 'loaded', settings });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<DecisionRoutingSection workspaceId="ws-1" />));
  await settle();
  return container;
}

/** A radio choice's own name, beside its radio and above its hint. */
function choiceName(label: HTMLLabelElement): string {
  return label.querySelector(':scope > span:last-child > span:first-child')?.textContent ?? '';
}

function radios(el: HTMLElement, group: string): HTMLLabelElement[] {
  const scope = el.querySelector(`[role="radiogroup"][aria-label="${group}"]`);
  if (!scope) return [];
  return [...scope.querySelectorAll('label')].filter((label) =>
    label.querySelector('[role="radio"]')
  );
}

async function choose(el: HTMLElement, group: string, name: string) {
  const label = radios(el, group).find((candidate) => choiceName(candidate) === name);
  if (!label) throw new Error(`no ${group} ${name}`);
  await act(async () => label.querySelector<HTMLElement>('[role="radio"]')!.click());
}

function machineRow(el: HTMLElement, name: string): HTMLLabelElement {
  const label = radios(el, 'Machine').find((candidate) => choiceName(candidate) === name);
  if (!label) throw new Error(`no machine ${name}`);
  return label;
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text
  );
  if (!found) throw new Error(`no button ${text}`);
  return found;
}

function stateLine(el: HTMLElement): string | null {
  return el.querySelector('[aria-label="Machine state"]')?.textContent ?? null;
}

it('offers running on one of my machines, with my machines in the picker', async () => {
  const el = await render(SERVER_DEFAULT);
  expect(radios(el, 'Decision backend').map(choiceName)).toContain('Run on one of my machines');
  expect(el.querySelector('[role="radiogroup"][aria-label="Machine"]')).toBeNull();

  await choose(el, 'Decision backend', 'Run on one of my machines');

  expect(radios(el, 'Machine').map(choiceName)).toEqual(['Mac-Studio', 'travel-laptop', 'old-box']);
  expect(machineRow(el, 'Mac-Studio').textContent).toContain('Apple Silicon, 64.0 GB memory');
  // Not connected now: flagged, and still choosable.
  const laptop = machineRow(el, 'travel-laptop');
  expect(laptop.textContent).toContain('Not connected now');
  expect(laptop.querySelector('[role="radio"]')?.hasAttribute('data-disabled')).toBe(false);
  // Can't run the model: listed with the reason, not choosable.
  const old = machineRow(el, 'old-box');
  expect(old.textContent).toContain('Update this machine’s controller');
  expect(old.querySelector('[role="radio"]')?.hasAttribute('data-disabled')).toBe(true);
  // Nothing chosen yet.
  expect(el.textContent).toContain('Choose one of your machines.');
  expect(button(el, 'Save').disabled).toBe(true);
  expect(button(el, 'Test').disabled).toBe(true);
});

it('won’t pick a machine that can’t run the model', async () => {
  const el = await render(SERVER_DEFAULT);
  await choose(el, 'Decision backend', 'Run on one of my machines');
  await act(async () =>
    machineRow(el, 'old-box').querySelector<HTMLElement>('[role="radio"]')!.click()
  );
  expect(
    machineRow(el, 'old-box').querySelector('[role="radio"]')?.getAttribute('aria-checked')
  ).toBe('false');
  expect(el.querySelector('[aria-label="Model"]')).toBeNull();
});

it('picks the machine’s model, then saves and tests the machine and model', async () => {
  switchServers.updateDecisionSettings.mockResolvedValue({
    kind: 'saved',
    settings: onMac({ state: 'off', ready: false }),
  });
  switchServers.testDecisionSettings.mockResolvedValue({
    kind: 'tested',
    outcome: {
      ok: false,
      agent: null,
      modelChoice: null,
      confidence: null,
      latencyMs: null,
      backend: 'machine',
      error: { code: 'machine_not_ready', message: 'Mac-Studio is still getting ready.' },
    },
  });
  const el = await render(SERVER_DEFAULT);
  await choose(el, 'Decision backend', 'Run on one of my machines');
  await choose(el, 'Machine', 'Mac-Studio');

  expect(el.querySelector('[aria-label="Model"]')?.textContent).toContain('Qwen3.5-4B');
  await act(async () => el.querySelector<HTMLElement>('[aria-label="Model"]')!.click());
  await vi.waitFor(() =>
    expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0)
  );
  expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
    'Qwen3.5-4B · fast · 2.7 GB download',
  ]);
  await act(async () => document.querySelector<HTMLElement>('[role="option"]')!.click());

  await act(async () => button(el, 'Test').click());
  expect(switchServers.testDecisionSettings).toHaveBeenCalledWith({
    workspaceId: 'ws-1',
    backend: 'machine',
    machineId: 'ctl-mac',
    model: 'qwen3.5-4b-q4_k_m',
  });
  await vi.waitFor(() =>
    expect(el.querySelector('[aria-label="Test result"]')?.textContent).toBe(
      'Test failed — Mac-Studio is still getting ready.'
    )
  );

  await act(async () => button(el, 'Save').click());
  expect(switchServers.updateDecisionSettings).toHaveBeenCalledWith({
    workspaceId: 'ws-1',
    backend: 'machine',
    machineId: 'ctl-mac',
    model: 'qwen3.5-4b-q4_k_m',
  });
  await vi.waitFor(() => expect(stateLine(el)).toBe('Decision model on Mac-Studio: Getting ready'));
  expect(el.textContent).toContain(
    'This workspace’s own setting applies: Run on one of my machines (Mac-Studio, Qwen3.5-4B).'
  );
});

it('shows a machine refused by the server with its reason, leaving the setting as it was', async () => {
  switchServers.updateDecisionSettings.mockResolvedValue({
    kind: 'invalid',
    message: 'You can only choose a machine you own.',
  });
  const el = await render(SERVER_DEFAULT);
  await choose(el, 'Decision backend', 'Run on one of my machines');
  await choose(el, 'Machine', 'Mac-Studio');
  await act(async () => button(el, 'Save').click());
  await vi.waitFor(() =>
    expect(el.textContent).toContain('Not saved — You can only choose a machine you own.')
  );
  expect(stateLine(el)).toBeNull();
});

it('says none of my machines is enrolled here when the list is empty', async () => {
  const el = await render({
    ...SERVER_DEFAULT,
    options: { ...SERVER_DEFAULT.options, machines: [] },
  });
  await choose(el, 'Decision backend', 'Run on one of my machines');
  expect(el.textContent).toContain('None of your machines is enrolled in this workspace.');
});

it.each([
  [{ state: 'off' as const, ready: false }, 'Getting ready'],
  [
    {
      state: 'downloading' as const,
      ready: false,
      progress: { doneBytes: 1_200_000_000, totalBytes: 2_700_000_000 },
    },
    'Downloading 1.2 / 2.7 GB',
  ],
  [{ state: 'starting' as const, ready: false }, 'Starting'],
  [
    { state: 'running' as const, lastDecisionMs: 480 },
    'Running · Qwen3.5-4B · last decision 0.48 s',
  ],
  [
    { state: 'failed' as const, ready: false, reason: 'not_enough_disk' },
    'Failed: not enough disk space (the model needs 2.7 GB)',
  ],
  [
    { state: 'failed' as const, reason: 'model_server_crashed' },
    'Failed: the model server kept crashing',
  ],
  [{ state: 'off' as const, reason: 'turned_off_on_machine' }, 'Turned off on the machine'],
  [{ connected: false }, 'Offline'],
])('shows the state line %#: %s', async (machine, text) => {
  const el = await render(onMac(machine));
  expect(stateLine(el)).toBe(`Decision model on Mac-Studio: ${text}`);
  expect(radios(el, 'Machine').map(choiceName)).toEqual(['Mac-Studio', 'travel-laptop', 'old-box']);
});

it('says since when a machine is offline', async () => {
  const since = new Date();
  since.setMinutes(since.getMinutes() - 5);
  const el = await render(onMac({ connected: false, since: since.toISOString() }));
  expect(stateLine(el)).toMatch(/^Decision model on Mac-Studio: Offline since \d/);
});

it('asks again every few seconds while the model gets ready, and stops once it runs', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const el = await render(
    onMac({
      state: 'downloading',
      ready: false,
      progress: { doneBytes: 1_200_000_000, totalBytes: 2_700_000_000 },
    })
  );
  expect(switchServers.getDecisionSettings).toHaveBeenCalledTimes(1);
  switchServers.getDecisionSettings.mockResolvedValue({
    kind: 'loaded',
    settings: onMac({ state: 'starting', ready: false }),
  });
  await act(async () => vi.advanceTimersByTime(MACHINE_POLL_MS));
  await settle();
  expect(switchServers.getDecisionSettings).toHaveBeenCalledTimes(2);
  expect(stateLine(el)).toBe('Decision model on Mac-Studio: Starting');

  switchServers.getDecisionSettings.mockResolvedValue({
    kind: 'loaded',
    settings: onMac({ state: 'running', lastDecisionMs: 510 }),
  });
  await act(async () => vi.advanceTimersByTime(MACHINE_POLL_MS));
  await settle();
  expect(stateLine(el)).toBe(
    'Decision model on Mac-Studio: Running · Qwen3.5-4B · last decision 0.51 s'
  );

  await act(async () => vi.advanceTimersByTime(MACHINE_POLL_MS * 3));
  await settle();
  expect(switchServers.getDecisionSettings).toHaveBeenCalledTimes(3);
});

it('does not ask again for a failed model', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await render(onMac({ state: 'failed', reason: 'download_failed' }));
  await act(async () => vi.advanceTimersByTime(MACHINE_POLL_MS * 3));
  await settle();
  expect(switchServers.getDecisionSettings).toHaveBeenCalledTimes(1);
});
