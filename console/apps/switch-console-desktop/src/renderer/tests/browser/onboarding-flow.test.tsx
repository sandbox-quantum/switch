/**
 * The path a fresh install takes to its first server.
 *
 * The server pages are the add-server wizard drawn full window, so what is
 * worth testing is not the wizard again but the joins: that the welcome page
 * leads into the question of where Switch runs, that each page can be backed
 * out of, and that the one thing the first-run form does differently — not
 * asking for a name — still produces a server with a name on it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const addServer = vi.hoisted(() => vi.fn());
const setActive = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const listHosts = vi.hoisted(() => vi.fn());
const switchCloud = vi.hoisted(() => vi.fn());
const connectToSwitchCloud = vi.hoisted(() => vi.fn());
const servers = vi.hoisted(() => [] as { id: string; name: string }[]);

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const precheckProviders = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: {
    remoteHosts: { listHosts },
    switchServers: { switchCloud },
    embeddedController: { precheckProviders },
  },
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    addServer,
    connectToSwitchCloud,
    setActive,
    serverById: (id: string | null) => servers.find((s) => s.id === id) ?? null,
    isConnected: () => false,
    errorText: null,
    ensureAuthConfig: () => Promise.resolve(),
    authConfigFor: () => ({
      passwordLoginEnabled: true,
      oidcEnabled: false,
      oidcProviderLabel: null,
      oidcLoginOptions: [],
      oidcBrowserHandoff: false,
    }),
    authConfigCheckFailed: () => false,
    authConfigChecking: () => false,
    passwordLogin: () => Promise.resolve(true),
    oidcLogin: () => Promise.resolve(true),
  },
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate }),
}));

/**
 * The local-server supervisor as the page sees it. Stands in for the real
 * singleton so a test can put the page in the middle of an install without a
 * Docker daemon anywhere near it.
 */
const localServer = vi.hoisted(() => ({
  status: null as { serverId: string | null; version: string } | null,
  docker: { available: true } as { available: boolean } | null,
  isRunning: false,
  isTransitioning: false,
  phase: 'stopped',
  message: null as string | null,
  error: null as string | null,
  errorDetail: null as string | null,
  logs: [] as string[],
  init: vi.fn(() => Promise.resolve()),
  checkDocker: vi.fn(() => Promise.resolve()),
  start: vi.fn(),
}));

vi.mock('@renderer/features/switch-servers/local-server-store', () => ({
  localServerStore: localServer,
}));

vi.mock('@renderer/lib/telemetry/report', () => ({ report: vi.fn() }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({
    value: { enabled: true, askedAt: 1 },
    update: () => {},
    isLoading: false,
    isSaving: false,
  }),
}));

import { OnboardingFlow } from '@renderer/features/onboarding/onboarding-flow';
vi.mock('@renderer/lib/hooks/useTheme', () => ({
  useTheme: () => ({ effectiveTheme: 'emlight' }),
}));

import { onboardingStore } from '@renderer/features/onboarding/onboarding-store';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  addServer.mockReset();
  setActive.mockReset();
  navigate.mockReset();
  listHosts.mockReset();
  listHosts.mockResolvedValue([]);
  switchCloud.mockReset();
  switchCloud.mockResolvedValue(null);
  connectToSwitchCloud.mockReset();
  servers.length = 0;
  onboardingStore.reset();
  // The intro has its own test; these start on Welcome, as after it.
  onboardingStore.introPlayed();
  Object.assign(localServer, {
    status: null,
    docker: { available: true },
    isRunning: false,
    isTransitioning: false,
    phase: 'stopped',
    message: null,
    error: null,
    errorDetail: null,
    logs: [],
  });
});

/** Register a server the way the connect page does, list and all. */
function serverAdded(id: string) {
  const server = {
    id,
    name: 'switch.example.com',
    gatewayUrl: 'https://switch.example.com',
    apiUrl: 'https://switch.example.com:8000',
  };
  servers.push(server);
  addServer.mockResolvedValue(server);
  return server;
}

/** Walk the connect page to the point where the server exists. */
async function addFromConnectPage(el: HTMLElement) {
  await act(async () => button(el, 'Get started').click());
  await choose(el, 'Join an existing server');
  await act(async () => button(el, 'Continue').click());
  await type(field(el, 'Gateway URL')!, 'https://switch.example.com');
  await type(field(el, 'API URL')!, 'https://switch.example.com:8000');
  await choose(el, 'Sign in to this server');
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function renderFlow(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<OnboardingFlow />));
  return container;
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label
  );
  expect(found, `no ${label} button`).toBeDefined();
  return found!;
}

/** Every button's label, for asserting that one is not among them. */
function labels(el: HTMLElement): (string | null)[] {
  return [...el.querySelectorAll('button')].map((b) => b.textContent);
}

/** A card or button whose text contains this, wherever it sits in the page. */
async function choose(el: HTMLElement, text: string): Promise<void> {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(text)
  );
  expect(found, `nothing to click named ${text}`).toBeDefined();
  await act(async () => found!.click());
}

function field(el: HTMLElement, label: string): HTMLInputElement | null {
  const labels = [...el.querySelectorAll<HTMLElement>('label')];
  const match = labels.find((l) => l.textContent?.trim() === label);
  if (!match) return null;
  const input = match.parentElement?.querySelector('input');
  expect(input, `no input under ${label}`).not.toBeNull();
  return input as HTMLInputElement;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the first-run flow', () => {
  it('opens on the intro the first time, and Skip goes on to Welcome for good', async () => {
    onboardingStore.rehearse();
    const el = await renderFlow();
    expect(el.textContent).not.toContain('Get started');
    await act(async () => button(el, 'Skip').click());
    await vi.waitFor(() => expect(el.textContent).toContain('Get started'));
    expect(onboardingStore.introPending).toBe(false);
    expect(localStorage.getItem('onboarding.introPlayed')).not.toBeNull();
  });

  it("checks this computer's providers as it opens, for switch-buddy at the end", async () => {
    precheckProviders.mockClear();
    await renderFlow();
    expect(precheckProviders).toHaveBeenCalledTimes(1);
  });

  it('asks how to run Switch once you get started, without the remote host path', async () => {
    const el = await renderFlow();

    await act(async () => button(el, 'Get started').click());

    expect(el.textContent).toContain('How do you want to run Switch?');
    expect(el.textContent).toContain('On this computer');
    expect(el.textContent).toContain('Join an existing server');
    expect(el.textContent).not.toContain('remote host');
    expect(listHosts).not.toHaveBeenCalled();
  });

  it('shows Switch Cloud as coming soon, and not choosable, when the build names none', async () => {
    const el = await renderFlow();
    await act(async () => button(el, 'Get started').click());

    expect(el.textContent).toContain('Switch Cloud');
    expect(el.textContent).toContain('Coming soon');
    const card = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Switch Cloud')
    );
    expect(card?.disabled).toBe(true);
  });

  it('goes back from the question to the welcome', async () => {
    const el = await renderFlow();
    await act(async () => button(el, 'Get started').click());

    await act(async () => button(el, 'Back').click());

    expect(onboardingStore.page).toBe('welcome');
  });

  it('starts the stack on this computer by default when there is no Cloud', async () => {
    const el = await renderFlow();
    await act(async () => button(el, 'Get started').click());

    await act(async () => button(el, 'Continue').click());

    expect(onboardingStore.page).toBe('local');
  });

  it('asks for the addresses, and not for a name, on the connect page', async () => {
    const el = await renderFlow();
    await act(async () => button(el, 'Get started').click());
    await choose(el, 'Join an existing server');
    await act(async () => button(el, 'Continue').click());

    expect(field(el, 'Gateway URL')).not.toBeNull();
    expect(field(el, 'API URL')).not.toBeNull();
    expect(field(el, 'Name')).toBeNull();
  });

  it('keeps the flow on screen after the server is added, for the sign-in still to come', async () => {
    serverAdded('srv-1');
    const el = await renderFlow();

    await addFromConnectPage(el);

    expect(onboardingStore.inProgress).toBe(true);
    expect(onboardingStore.page).toBe('signIn');
  });

  it('offers a way out by name once the server exists', async () => {
    serverAdded('srv-1');
    const el = await renderFlow();
    await addFromConnectPage(el);

    await act(async () => button(el, 'Finish later').click());

    expect(onboardingStore.inProgress).toBe(false);
    expect(navigate).toHaveBeenCalledWith('server', { serverId: 'srv-1' });
  });

  it('offers nothing to finish later before a server has been registered', async () => {
    const el = await renderFlow();
    await act(async () => button(el, 'Get started').click());

    expect(labels(el)).not.toContain('Finish later');
  });
});

describe('the first-run flow with Switch Cloud named', () => {
  const CLOUD = {
    id: 'cloud-1',
    name: 'Switch Cloud',
    gatewayUrl: 'https://cloud.example.com',
    apiUrl: 'https://cloud.example.com',
  };

  beforeEach(() => {
    switchCloud.mockResolvedValue({ url: 'https://cloud.example.com' });
    servers.push(CLOUD);
    connectToSwitchCloud.mockResolvedValue(CLOUD);
  });

  async function atHowToRun(): Promise<HTMLDivElement> {
    const el = await renderFlow();
    await act(async () => button(el, 'Get started').click());
    return el;
  }

  it('recommends the Cloud and goes straight to signing in to it', async () => {
    const el = await atHowToRun();
    expect(el.textContent).toContain('Recommended');

    await act(async () => button(el, 'Continue').click());

    expect(connectToSwitchCloud).toHaveBeenCalled();
    expect(onboardingStore.page).toBe('signIn');
    expect(onboardingStore.server?.id).toBe('cloud-1');
  });

  it('goes back from signing in to the question, not to a connect page it never showed', async () => {
    const el = await atHowToRun();
    await act(async () => button(el, 'Continue').click());

    await act(async () => button(el, 'Back').click());

    expect(onboardingStore.page).toBe('howToRun');
  });

  it('stays on the question and says why when the Cloud cannot be registered', async () => {
    connectToSwitchCloud.mockRejectedValue(new Error('disk full'));
    const el = await atHowToRun();

    await act(async () => button(el, 'Continue').click());

    expect(onboardingStore.page).toBe('howToRun');
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('disk full');
  });
});
