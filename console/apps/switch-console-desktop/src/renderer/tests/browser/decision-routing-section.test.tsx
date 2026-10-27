/**
 * A workspace's decision routing on the Admin page: which setting applies
 * (its own or the server's default), the backends the server can run, a key
 * shown only by its last four characters, a save that shows what the server
 * stored, a return to the server default, and a test of the values as
 * entered, showing the pick, confidence and latency or why it failed.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DecisionSettings } from '@shared/core/switch-servers/switch-servers';

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

import { DecisionRoutingSection } from '@renderer/features/admin/decision-routing-section';

const SERVER_DEFAULT: DecisionSettings = {
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
};

const OWN_HAIKU: DecisionSettings = {
  ...SERVER_DEFAULT,
  source: 'workspace',
  effective: {
    backend: 'haiku_anthropic',
    endpoint: null,
    threshold: 0.4,
    available: true,
    reason: null,
  },
  workspace: {
    backend: 'haiku_anthropic',
    endpoint: null,
    threshold: 0.4,
    hasApiKey: true,
    apiKeyLast4: 'AwcA',
    apiKeyUnreadable: false,
    updatedAt: '2026-10-27T10:00:00Z',
  },
};

const NO_SERVICE: DecisionSettings = {
  ...SERVER_DEFAULT,
  effective: {
    backend: 'none',
    endpoint: null,
    threshold: null,
    available: false,
    reason:
      'Auto-route needs a decision service. A workspace admin can set one up in Switch Console → Admin → Decision routing.',
  },
  serverDefault: { configured: false, endpoint: null, hasApiKey: false },
  options: { haikuAnthropic: false, haikuBedrock: false },
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  for (const mock of Object.values(switchServers)) mock.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(settings: DecisionSettings | { kind: string }): Promise<HTMLElement> {
  switchServers.getDecisionSettings.mockResolvedValue(
    'kind' in settings ? settings : { kind: 'loaded', settings }
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<DecisionRoutingSection workspaceId="ws-1" />));
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
  return container;
}

/** A backend choice's own name, beside its radio and above its hint. */
function choiceName(label: HTMLLabelElement): string {
  return label.querySelector(':scope > span:last-child > span:first-child')?.textContent ?? '';
}

function choices(el: HTMLElement): string[] {
  return [...el.querySelectorAll('label')]
    .filter((label) => label.querySelector('[role="radio"]'))
    .map(choiceName);
}

async function choose(el: HTMLElement, choice: string) {
  const label = [...el.querySelectorAll('label')].find(
    (candidate) => candidate.querySelector('[role="radio"]') && choiceName(candidate) === choice
  );
  if (!label) throw new Error(`no choice ${choice}`);
  await act(async () => label.querySelector<HTMLElement>('[role="radio"]')!.click());
}

function button(el: HTMLElement, text: string | RegExp): HTMLButtonElement {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')
  );
  if (!found) throw new Error(`no button ${text}`);
  return found;
}

async function type(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function field(el: HTMLElement, id: string): HTMLInputElement {
  const input = el.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`no field ${id}`);
  return input;
}

it('says the server default applies, what it is, and offers Haiku but not Bedrock', async () => {
  const el = await render(SERVER_DEFAULT);

  expect(switchServers.getDecisionSettings).toHaveBeenCalledWith('ws-1');
  expect(el.textContent).toContain(
    'This workspace uses the server default: self-hosted decision service (http://decision:8230).'
  );
  expect(choices(el)).toEqual([
    'Use server default',
    'None',
    'Self-hosted endpoint',
    'Haiku (Anthropic API)',
  ]);
  expect(el.textContent).toContain('Haiku on Bedrock isn’t offered');
  // Nothing to save while the server default is chosen and applies.
  expect(button(el, 'Save').disabled).toBe(true);
  expect(
    [...el.querySelectorAll('button')].some((b) => b.textContent === 'Use server default')
  ).toBe(false);
});

it('explains why Haiku is missing, and why auto-route is unavailable, on a server without a decision service', async () => {
  const el = await render(NO_SERVICE);

  expect(choices(el)).toEqual(['Use server default', 'None', 'Self-hosted endpoint']);
  expect(el.textContent).toContain('this server has none configured');
  expect(el.textContent).toContain('none — this server has no decision service configured');
  expect(el.querySelector('[role="alert"]')?.textContent).toContain(
    'Auto-route needs a decision service.'
  );
  expect(button(el, 'Test').disabled).toBe(true);
});

it('shows the workspace’s own setting and a stored key only by its last four characters', async () => {
  const el = await render(OWN_HAIKU);

  expect(el.textContent).toContain('This workspace’s own setting applies: Haiku (Anthropic API).');
  expect(el.textContent).toContain('(set, ending in AwcA)');
  expect(field(el, 'decision-key').value).toBe('');
  expect(field(el, 'decision-threshold').value).toBe('0.4');
  expect(button(el, 'Use server default')).toBeTruthy();
});

it('says a key it can no longer read is unreadable, and still lets a new one be saved', async () => {
  const el = await render({
    ...OWN_HAIKU,
    workspace: { ...OWN_HAIKU.workspace!, apiKeyLast4: null, apiKeyUnreadable: true },
  });

  expect(el.textContent).toContain('set but unreadable — enter a new key to replace it');
  expect(button(el, 'Save').disabled).toBe(true);
  await type(field(el, 'decision-key'), 'fake-key');
  expect(button(el, 'Save').disabled).toBe(false);
});

it('saves a self-hosted endpoint, then shows what the server stored', async () => {
  const stored: DecisionSettings = {
    ...SERVER_DEFAULT,
    source: 'workspace',
    effective: {
      backend: 'endpoint',
      endpoint: 'https://decide.example',
      threshold: 0.5,
      available: true,
      reason: null,
    },
    workspace: {
      backend: 'endpoint',
      endpoint: 'https://decide.example',
      threshold: 0.5,
      hasApiKey: false,
      apiKeyLast4: null,
      apiKeyUnreadable: false,
      updatedAt: '2026-10-27T10:00:00Z',
    },
  };
  switchServers.updateDecisionSettings.mockResolvedValue({ kind: 'saved', settings: stored });
  const el = await render(SERVER_DEFAULT);

  await choose(el, 'Self-hosted endpoint');
  expect(button(el, 'Save').disabled).toBe(true);
  await type(field(el, 'decision-endpoint'), 'https://decide.example');
  await type(field(el, 'decision-threshold'), '0.5');
  await act(async () => button(el, 'Save').click());

  expect(switchServers.updateDecisionSettings).toHaveBeenCalledWith({
    workspaceId: 'ws-1',
    backend: 'endpoint',
    endpoint: 'https://decide.example',
    threshold: 0.5,
  });
  await vi.waitFor(() =>
    expect(el.textContent).toContain(
      'This workspace’s own setting applies: Self-hosted endpoint (https://decide.example).'
    )
  );
  expect(el.textContent).toContain('Saved.');
});

it('holds a threshold outside 0 to 1, and shows a refusal from the server in its words', async () => {
  switchServers.updateDecisionSettings.mockResolvedValue({
    kind: 'invalid',
    message: 'threshold: Input should be less than or equal to 1',
  });
  const el = await render(SERVER_DEFAULT);
  await choose(el, 'Self-hosted endpoint');
  await type(field(el, 'decision-endpoint'), 'https://decide.example');

  await type(field(el, 'decision-threshold'), '1.5');
  expect(el.textContent).toContain('The threshold must be between 0 and 1.');
  expect(button(el, 'Save').disabled).toBe(true);

  await type(field(el, 'decision-threshold'), '1');
  await act(async () => button(el, 'Save').click());
  await vi.waitFor(() =>
    expect(el.textContent).toContain(
      'Not saved — threshold: Input should be less than or equal to 1'
    )
  );
  expect(el.textContent).toContain('This workspace uses the server default');
});

it('returns the workspace to the server default', async () => {
  switchServers.clearDecisionSettings.mockResolvedValue({
    kind: 'cleared',
    settings: SERVER_DEFAULT,
  });
  const el = await render(OWN_HAIKU);

  await act(async () => button(el, 'Use server default').click());

  expect(switchServers.clearDecisionSettings).toHaveBeenCalledWith('ws-1');
  await vi.waitFor(() =>
    expect(el.textContent).toContain('This workspace uses the server default')
  );
});

it('tests the unsaved values and shows the pick, confidence and latency', async () => {
  switchServers.testDecisionSettings.mockResolvedValue({
    kind: 'tested',
    outcome: {
      ok: true,
      agent: 'deploy-bot',
      modelChoice: 'deploy-bot',
      confidence: 0.91,
      latencyMs: 420,
      backend: 'endpoint',
      error: null,
    },
  });
  const el = await render(SERVER_DEFAULT);
  await choose(el, 'Self-hosted endpoint');
  await type(field(el, 'decision-endpoint'), 'https://decide.example');

  await act(async () => button(el, 'Test').click());

  expect(switchServers.testDecisionSettings).toHaveBeenCalledWith({
    workspaceId: 'ws-1',
    backend: 'endpoint',
    endpoint: 'https://decide.example',
    threshold: null,
  });
  expect(switchServers.updateDecisionSettings).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(el.querySelector('[aria-label="Test result"]')?.textContent).toBe(
      'Picked deploy-bot · confidence 0.91 · 0.42 s'
    )
  );
});

it('tests the server default it uses', async () => {
  switchServers.testDecisionSettings.mockResolvedValue({
    kind: 'tested',
    outcome: {
      ok: true,
      agent: null,
      modelChoice: 'none',
      confidence: 0.2,
      latencyMs: 380,
      backend: 'endpoint',
      error: null,
    },
  });
  const el = await render(SERVER_DEFAULT);

  await act(async () => button(el, 'Test').click());

  expect(switchServers.testDecisionSettings).toHaveBeenCalledWith({
    workspaceId: 'ws-1',
    backend: 'default',
  });
  await vi.waitFor(() =>
    expect(el.querySelector('[aria-label="Test result"]')?.textContent).toBe(
      'Picked nobody (none) · confidence 0.20 · 0.38 s'
    )
  );
});

it('tests the server default before returning to it, whatever the workspace saved', async () => {
  switchServers.testDecisionSettings.mockResolvedValue({
    kind: 'tested',
    outcome: {
      ok: true,
      agent: 'deploy-bot',
      modelChoice: 'deploy-bot',
      confidence: 0.8,
      latencyMs: 300,
      backend: 'default',
      error: null,
    },
  });
  const el = await render(OWN_HAIKU);
  await choose(el, 'Use server default');

  await act(async () => button(el, 'Test').click());

  expect(switchServers.testDecisionSettings).toHaveBeenCalledWith({
    workspaceId: 'ws-1',
    backend: 'default',
  });
  await vi.waitFor(() =>
    expect(el.querySelector('[aria-label="Test result"]')?.textContent).toBe(
      'Picked deploy-bot · confidence 0.80 · 0.30 s'
    )
  );
  expect(switchServers.clearDecisionSettings).not.toHaveBeenCalled();
});

it('shows why a test failed, saving nothing', async () => {
  switchServers.testDecisionSettings.mockResolvedValue({
    kind: 'tested',
    outcome: {
      ok: false,
      agent: null,
      modelChoice: null,
      confidence: null,
      latencyMs: null,
      backend: 'haiku_anthropic',
      error: { code: 'key_refused', message: 'The Anthropic API refused the key.' },
    },
  });
  const el = await render(SERVER_DEFAULT);
  await choose(el, 'Haiku (Anthropic API)');
  await type(field(el, 'decision-key'), 'sk-wrong');

  await act(async () => button(el, 'Test').click());

  expect(switchServers.testDecisionSettings).toHaveBeenCalledWith(
    expect.objectContaining({ backend: 'haiku_anthropic', apiKey: 'sk-wrong' })
  );
  await vi.waitFor(() =>
    expect(el.querySelector('[aria-label="Test result"]')?.textContent).toBe(
      'Test failed — The Anthropic API refused the key.'
    )
  );
  expect(switchServers.updateDecisionSettings).not.toHaveBeenCalled();
});

it('tells a member who is not the workspace’s admin that it is theirs to change', async () => {
  const el = await render({ kind: 'forbidden' });

  expect(el.textContent).toContain(
    'Only an admin of this workspace can view or change its decision routing.'
  );
  expect(el.querySelector('[role="radio"]')).toBeNull();
});
