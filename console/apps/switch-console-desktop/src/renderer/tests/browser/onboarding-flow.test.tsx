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
const updateServer = vi.hoisted(() => vi.fn());
const storeError = vi.hoisted(() => ({ text: null as string | null }));
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
    updateServer,
    connectToSwitchCloud,
    setActive,
    serverById: (id: string | null) => servers.find((s) => s.id === id) ?? null,
    isConnected: () => false,
    get errorText() {
      return storeError.text;
    },
    ensureAuthConfig: () => Promise.resolve(),
    authConfigFor: () => ({
      passwordLoginEnabled: true,
      oidcEnabled: false,
      oidcProviderLabel: null,
      oidcLoginOptions: [],
      oidcBrowserHandoff: false,
      testAccountResetEnabled: false,
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
  runtime: 'native' as 'native' | 'docker' | null,
  message: null as string | null,
  error: null as string | null,
  errorDetail: null as string | null,
  logs: [] as string[],
  init: vi.fn(() => Promise.resolve()),
  checkDocker: vi.fn(() => Promise.resolve()),
  start: vi.fn(() => Promise.resolve()),
  reset: vi.fn(() => Promise.resolve()),
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

import { LocalSetupProgress } from '@renderer/features/onboarding/local-setup-progress';
import { onboardingStore } from '@renderer/features/onboarding/onboarding-store';
import { ExternalServerStep } from '@renderer/features/switch-servers/AddServerModal';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  addServer.mockReset();
  updateServer.mockReset();
  storeError.text = null;
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
    runtime: 'native',
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
    url: 'https://switch.example.com',
    dashboardUrl: null,
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
  await type(field(el, 'Server address')!, 'https://switch.example.com');
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

    expect(el.textContent).toContain('How do you want to run Switch Rooms?');
    expect(el.textContent).toContain('On this computer');
    expect(el.textContent).toContain('Join an existing server');
    expect(el.textContent).not.toContain('remote host');
    expect(listHosts).not.toHaveBeenCalled();
  });

  it('lists Switch Cloud last, as coming soon, and not choosable', async () => {
    const el = await renderFlow();
    await act(async () => button(el, 'Get started').click());

    const options = [...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('On this computer'),
      expect.stringContaining('Join an existing server'),
      expect.stringContaining('Switch Cloud'),
    ]);
    const card = options.at(-1)!;
    expect(card.textContent).toContain('Coming soon');
    expect(card.disabled).toBe(true);
    expect(card.getAttribute('aria-disabled')).toBe('true');
    expect(card.getAttribute('aria-checked')).toBe('false');
  });

  it('goes back from the question to the welcome', async () => {
    const el = await renderFlow();
    await act(async () => button(el, 'Get started').click());

    await act(async () => button(el, 'Back').click());

    expect(onboardingStore.page).toBe('welcome');
  });

  it('picks the stack on this computer by default when there is no Cloud', async () => {
    const el = await renderFlow();
    await act(async () => button(el, 'Get started').click());

    await act(async () => button(el, 'Continue').click());

    expect(onboardingStore.page).toBe('local');
  });

  it('sets the server up on this computer without a page asking to start it', async () => {
    localServer.start.mockClear();
    localServer.start.mockImplementationOnce(() => {
      localServer.isTransitioning = true;
      return Promise.resolve();
    });
    const el = await renderFlow();
    await act(async () => button(el, 'Get started').click());

    await act(async () => button(el, 'Continue').click());

    expect(localServer.start).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain('Setting things up…');
    expect(el.textContent).not.toContain('Set up a server on this computer');
  });

  it('tells the setup as plain stages, not the steps it reports', async () => {
    Object.assign(localServer, { isTransitioning: true, message: 'Starting PostgreSQL…' });
    const el = await renderFlow();
    await act(async () => button(el, 'Get started').click());

    await act(async () => button(el, 'Continue').click());

    const states = [...el.querySelectorAll('li[data-state]')].map(
      (li) => `${li.textContent} ${li.getAttribute('data-state')}`
    );
    expect(states).toEqual([
      'Getting what’s needed done',
      'Preparing the database current',
      'Starting Switch next',
      'Signing you in next',
    ]);
    expect(el.textContent).not.toContain('PostgreSQL');
  });

  it('moves on by itself, with the server, once the server on this computer is up', async () => {
    Object.assign(localServer, {
      status: { serverId: 'local-1', version: '1.0.0' },
      isRunning: true,
      phase: 'running',
    });
    const onDone = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () =>
      root!.render(<LocalSetupProgress onBack={() => {}} onDone={onDone} onRegistered={() => {}} />)
    );

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith('local-1');
  });

  it('waits for the start to finish, not just for the server to report running', async () => {
    Object.assign(localServer, {
      status: { serverId: 'local-1', version: '1.0.0' },
      isRunning: true,
      isTransitioning: true,
      phase: 'running',
    });
    const onDone = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () =>
      root!.render(<LocalSetupProgress onBack={() => {}} onDone={onDone} onRegistered={() => {}} />)
    );

    expect(onDone).not.toHaveBeenCalled();
  });

  it('opens the full setup page, with the error and Retry, when the server could not start', async () => {
    localServer.start.mockImplementationOnce(() => {
      Object.assign(localServer, { phase: 'error', error: 'PostgreSQL did not start.' });
      return Promise.resolve();
    });
    const el = await renderFlow();
    await act(async () => button(el, 'Get started').click());

    await act(async () => button(el, 'Continue').click());

    expect(el.textContent).toContain('Set up a server on this computer');
    expect(el.textContent).toContain('PostgreSQL did not start.');
    expect(labels(el).some((l) => l?.startsWith('Retry'))).toBe(true);
  });

  it('asks for the one address, and not for a name, on the connect page', async () => {
    const el = await renderFlow();
    await act(async () => button(el, 'Get started').click());
    await choose(el, 'Join an existing server');
    await act(async () => button(el, 'Continue').click());

    expect(field(el, 'Server address')).not.toBeNull();
    expect(field(el, 'Gateway URL')).toBeNull();
    expect(field(el, 'API URL')).toBeNull();
    expect(field(el, 'Name')).toBeNull();
  });

  it('names the server after its address, having never asked', async () => {
    // The page that skips the question still has to produce a name: an
    // unnamed row in the sidebar would be the cost of the shortcut.
    serverAdded('srv-1');
    const el = await renderFlow();

    await addFromConnectPage(el);

    expect(addServer).toHaveBeenCalledWith(
      'switch.example.com',
      'https://switch.example.com',
      false
    );
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
  // Switch Cloud is not open to first runs yet: a build that has been told
  // where it is must still show it as coming soon and never start its path.
  beforeEach(() => {
    switchCloud.mockResolvedValue({ url: 'https://cloud.example.com' });
  });

  async function atHowToRun(): Promise<HTMLDivElement> {
    const el = await renderFlow();
    await act(async () => button(el, 'Get started').click());
    return el;
  }

  function cloudCard(el: HTMLElement): HTMLButtonElement {
    const card = [...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) =>
      b.textContent?.includes('Switch Cloud')
    );
    expect(card, 'no Switch Cloud card').toBeDefined();
    return card!;
  }

  it('still lists the Cloud last, as coming soon and disabled, never recommended', async () => {
    const el = await atHowToRun();
    // Give a Cloud configuration the chance to arrive, as it used to.
    await act(async () => {});

    const options = [...el.querySelectorAll('[role="radio"]')];
    expect(options.at(-1)).toBe(cloudCard(el));
    expect(cloudCard(el).disabled).toBe(true);
    expect(el.textContent).toContain('Coming soon');
    expect(el.textContent).not.toContain('Recommended');
  });

  it('preselects the stack on this computer, not the Cloud', async () => {
    const el = await atHowToRun();
    await act(async () => {});

    const checked = el.querySelectorAll('[role="radio"][aria-checked="true"]');
    expect(checked).toHaveLength(1);
    expect(checked[0].textContent).toContain('On this computer');

    await act(async () => button(el, 'Continue').click());

    expect(onboardingStore.page).toBe('local');
    expect(connectToSwitchCloud).not.toHaveBeenCalled();
  });

  it('ignores a click on the Cloud card and keeps the choice made', async () => {
    const el = await atHowToRun();
    await choose(el, 'Join an existing server');

    await act(async () => cloudCard(el).click());
    cloudCard(el).dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(cloudCard(el).getAttribute('aria-checked')).toBe('false');
    await act(async () => button(el, 'Continue').click());
    expect(onboardingStore.page).toBe('connect');
    expect(connectToSwitchCloud).not.toHaveBeenCalled();
  });

  it('cannot be reached from the keyboard', async () => {
    const el = await atHowToRun();
    const card = cloudCard(el);

    card.focus();

    expect(document.activeElement).not.toBe(card);
  });

  it('still offers no Cloud after walking back to the question and forward again', async () => {
    const el = await atHowToRun();
    await act(async () => button(el, 'Continue').click());
    expect(onboardingStore.page).toBe('local');

    // Back as the local page's own Back goes, whichever of its two faces is up.
    await act(async () => onboardingStore.back());
    expect(onboardingStore.page).toBe('howToRun');
    expect(cloudCard(el).disabled).toBe(true);
    expect(el.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain(
      'On this computer'
    );
    expect(connectToSwitchCloud).not.toHaveBeenCalled();
  });
});

describe('the server address form', () => {
  it('says why an address was refused, and stays on the form', async () => {
    addServer.mockResolvedValue(null);
    storeError.text =
      'https://switch-gateway.example.com answered with a web page, not the Switch server.';
    const el = await renderFlow();

    await act(async () => button(el, 'Get started').click());
    await choose(el, 'Join an existing server');
    await act(async () => button(el, 'Continue').click());
    await type(field(el, 'Server address')!, 'https://switch-gateway.example.com');
    await choose(el, 'Sign in to this server');

    expect(el.textContent).toContain('answered with a web page, not the Switch server.');
    expect(field(el, 'Server address')).not.toBeNull();
  });

  it('asks for a full address before it will go on', async () => {
    const el = await renderFlow();

    await act(async () => button(el, 'Get started').click());
    await choose(el, 'Join an existing server');
    await act(async () => button(el, 'Continue').click());
    await type(field(el, 'Server address')!, 'switch.example.com');

    expect(el.textContent).toContain('Enter a full address, e.g. https://switch.example.com');
    const submit = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Sign in to this server')
    );
    expect(submit?.disabled).toBe(true);
  });

  it('edits a connection through its one address', async () => {
    updateServer.mockResolvedValue({
      server: { id: 'srv-1', name: 'Team', url: 'https://new.example.com', dashboardUrl: null },
      propagation: { urlChanged: true, agents: [] },
    });
    const onSuccess = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <Dialog open>
          <DialogContent>
            <ExternalServerStep
              initialUrl="https://switch.example.com"
              initialName="Team"
              serverId="srv-1"
              isEdit
              firstRun={false}
              existing={null}
              onSuccess={onSuccess}
              onClose={vi.fn()}
              onBack={null}
              onConnected={vi.fn()}
            />
          </DialogContent>
        </Dialog>
      )
    );
    // The dialog renders into a portal on the body, not inside the container.
    const el = document.body;

    expect(el.textContent).toContain('Edit connection');
    expect(field(el, 'Server address')?.value).toBe('https://switch.example.com');
    expect(field(el, 'Gateway URL')).toBeNull();
    expect(field(el, 'API URL')).toBeNull();

    await type(field(el, 'Server address')!, 'https://new.example.com');
    await choose(el, 'Save changes');

    expect(updateServer).toHaveBeenCalledWith('srv-1', 'Team', 'https://new.example.com', false);
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});
