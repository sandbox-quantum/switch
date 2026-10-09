/**
 * The path a fresh install takes to its first server.
 *
 * The flow is the add-server wizard drawn full window, so what is worth testing
 * is not the wizard again but the joins: that the welcome page leads into the
 * question rather than a dialog, that each page can be backed out of, and that
 * the one thing the first-run form does differently — not asking for a name —
 * still produces a server with a name on it.
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

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { remoteHosts: { listHosts }, switchServers: { switchCloud } },
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    addServer,
    updateServer,
    connectToSwitchCloud,
    setActive,
    serverById: (id: string | null) => servers.find((s) => s.id === id) ?? null,
    get errorText() {
      return storeError.text;
    },
    ensureAuthConfig: () => Promise.resolve(),
    authConfigFor: () => ({
      passwordLoginEnabled: true,
      oidcEnabled: false,
      oidcProviderLabel: null,
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

import { OnboardingFlow } from '@renderer/features/onboarding/onboarding-flow';
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
    url: 'https://switch.example.com',
    dashboardUrl: null,
  };
  servers.push(server);
  addServer.mockResolvedValue(server);
  return server;
}

/** Walk the connect page to the point where the server exists. */
async function addFromConnectPage(el: HTMLElement) {
  await act(async () => button(el, 'Continue with your own server').click());
  await choose(el, "It's already running");
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
  it('asks who runs the server once you continue past the welcome', async () => {
    const el = await renderFlow();

    await act(async () => button(el, 'Continue with your own server').click());

    expect(el.textContent).toContain('Who runs the server?');
    expect(el.textContent).toContain('Set it up for me');
    expect(el.textContent).toContain("It's already running");
  });

  it('leaves the managed host path out when there is no host to offer', async () => {
    // A fresh install has onboarded none, and the card would lead to an empty
    // list every time it was taken.
    const el = await renderFlow();

    await act(async () => button(el, 'Continue with your own server').click());

    expect(el.textContent).not.toContain('one of my hosts');
  });

  it('offers the managed host path once a host exists', async () => {
    // Onboarding a host needs no server, so someone who deleted their last
    // server arrives here with hosts already set up — and this is the only
    // place the managed path can be reached from.
    listHosts.mockResolvedValue([{ sshHost: 'build-box' }]);
    const el = await renderFlow();

    await act(async () => button(el, 'Continue with your own server').click());

    expect(el.textContent).toContain('one of my hosts');
  });

  it('paints no cards until it knows whether there are hosts to offer', async () => {
    // The set waits as a whole. Painting two and inserting a third between them
    // a round trip later moves the answer out from under a cursor already on
    // its way to one.
    let answer!: (list: { sshHost: string }[]) => void;
    listHosts.mockReturnValue(
      new Promise<{ sshHost: string }[]>((resolve) => {
        answer = resolve;
      })
    );
    const el = await renderFlow();

    await act(async () => button(el, 'Continue with your own server').click());

    expect(el.textContent).toContain('Looking for onboarded hosts');
    expect(el.textContent).not.toContain('Set it up for me');

    await act(async () => answer([{ sshHost: 'build-box' }]));

    expect(el.textContent).toContain('Set it up for me');
    expect(el.textContent).toContain('one of my hosts');
  });

  it('says the host check failed instead of reporting no hosts', async () => {
    // A read that never answered is not an empty list. Reading it as one hides
    // a path the user has already set up, and says nothing about why.
    listHosts.mockRejectedValue(new Error('could not read the ssh config'));
    const el = await renderFlow();

    await act(async () => button(el, 'Continue with your own server').click());

    expect(el.textContent).toContain('Could not check for onboarded hosts');
    expect(el.textContent).not.toContain('one of my hosts');
    // The two paths that need no such check are still offered: not knowing
    // about hosts is no reason to hold the whole question hostage.
    expect(el.textContent).toContain('Set it up for me');
    expect(el.textContent).toContain("It's already running");
  });

  it('offers the host path when a retry of the check answers', async () => {
    listHosts.mockRejectedValueOnce(new Error('could not read the ssh config'));
    const el = await renderFlow();
    await act(async () => button(el, 'Continue with your own server').click());

    listHosts.mockResolvedValue([{ sshHost: 'build-box' }]);
    await act(async () => button(el, 'Try again').click());

    expect(el.textContent).toContain('one of my hosts');
  });

  it('can be left while the local stack is installing, and says so', async () => {
    // A first run pulls a few gigabytes. Full window, with Back shut and the
    // primary disabled, that was minutes of a page with no live control at all
    // — while the same page in the dialog could still be dismissed.
    localServer.isTransitioning = true;
    localServer.phase = 'starting';
    localServer.message = 'Pulling images…';
    const el = await renderFlow();
    await act(async () => button(el, 'Continue with your own server').click());
    await choose(el, 'Set it up for me');

    expect(button(el, 'Back').disabled).toBe(false);
    expect(el.textContent).toContain('keeps running if you leave the page');

    await act(async () => button(el, 'Back').click());

    expect(el.textContent).toContain('Who runs the server?');
  });

  it('goes back from the question to the welcome, by a button and not only a chevron', async () => {
    // The chevron is unlabelled, so it may repeat the way back but never be the
    // only one.
    const el = await renderFlow();

    await act(async () => button(el, 'Continue with your own server').click());
    await act(async () => button(el, 'Back').click());

    expect(el.textContent).toContain('Welcome to Switch');
  });

  it('asks for the one address, and not for a name, on the connect page', async () => {
    // Someone connecting their only server has nothing to tell it apart from,
    // so the field is a question asked for the list's benefit rather than
    // theirs.
    const el = await renderFlow();

    await act(async () => button(el, 'Continue with your own server').click());
    await choose(el, "It's already running");

    expect(el.textContent).toContain('Connect to your server');
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

    expect(addServer).toHaveBeenCalledWith('switch.example.com', 'https://switch.example.com');
  });

  it('keeps the flow on screen after the server is added, for the sign-in still to come', async () => {
    // The server exists from here on, which is exactly when the window would
    // otherwise decide onboarding is over and take the remaining pages away.
    serverAdded('srv-1');
    const el = await renderFlow();

    await addFromConnectPage(el);

    expect(onboardingStore.inProgress).toBe(true);
    expect(onboardingStore.page).toBe('signIn');
  });

  it('offers a way out by name once the server exists', async () => {
    // Sign-in can fail for good — a server that is down, a password that is
    // refused — and pressing Back until the window changes shape is not an
    // exit anyone finds.
    serverAdded('srv-1');
    const el = await renderFlow();

    await addFromConnectPage(el);
    await act(async () => button(el, 'Finish later').click());

    expect(onboardingStore.inProgress).toBe(false);
    expect(navigate).toHaveBeenCalledWith('server', { serverId: 'srv-1' });
  });

  it('offers nothing to finish later before a server has been registered', async () => {
    const el = await renderFlow();

    await act(async () => button(el, 'Continue with your own server').click());

    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
      'Finish later'
    );
  });

  it('offers no way out to a server the page on screen did not set up', async () => {
    // Connect to one, walk back, take the local path instead: the exit read a
    // single remembered server, so it still pointed at the abandoned attempt —
    // and pressing it left for a server this page had nothing to do with.
    serverAdded('srv-1');
    const el = await renderFlow();
    await addFromConnectPage(el);
    expect(labels(el)).toContain('Finish later');

    await act(async () => button(el, 'Back').click());
    await act(async () => button(el, 'Back').click());
    await choose(el, 'Set it up for me');

    expect(el.textContent).toContain('Set up a server on this computer');
    expect(labels(el)).not.toContain('Finish later');
  });

  it('forgets a server it registered when the user walks back to the start', async () => {
    // Everything after the connect page edits that row, and the user is free to
    // delete it the moment it exists — the window is the workspace again for
    // anything that does not need a server. A remembered id would aim the next
    // attempt's save at a row that is gone.
    serverAdded('srv-1');
    const el = await renderFlow();

    await addFromConnectPage(el);
    onboardingStore.goTo('welcome');

    expect(onboardingStore.server).toBeNull();
    expect(el).toBeDefined();
  });
});

describe('the first-run flow with Switch Cloud named', () => {
  const CLOUD = {
    id: 'cloud-1',
    name: 'Switch Cloud',
    url: 'https://cloud.example.com',
    dashboardUrl: null,
  };

  beforeEach(() => {
    switchCloud.mockResolvedValue({ url: 'https://cloud.example.com' });
    servers.push(CLOUD);
    connectToSwitchCloud.mockResolvedValue(CLOUD);
  });

  it('goes straight to signing in, with no question about who runs it', async () => {
    const el = await renderFlow();

    await act(async () => button(el, 'Continue with Switch Cloud').click());

    expect(connectToSwitchCloud).toHaveBeenCalled();
    expect(onboardingStore.page).toBe('signIn');
    expect(onboardingStore.server?.id).toBe('cloud-1');
    expect(el.textContent).not.toContain('Who runs the server?');
  });

  it('goes back from signing in to the welcome, not to a connect page it never showed', async () => {
    const el = await renderFlow();
    await act(async () => button(el, 'Continue with Switch Cloud').click());

    await act(async () => button(el, 'Back').click());

    expect(onboardingStore.page).toBe('welcome');
  });

  it('stays on the welcome and says why when the Cloud cannot be registered', async () => {
    connectToSwitchCloud.mockRejectedValue(new Error('disk full'));
    const el = await renderFlow();

    await act(async () => button(el, 'Continue with Switch Cloud').click());

    expect(onboardingStore.page).toBe('welcome');
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('disk full');
  });
});

describe('the server address form', () => {
  it('says why an address was refused, and stays on the form', async () => {
    addServer.mockResolvedValue(null);
    storeError.text =
      'https://switch-gateway.example.com answered with a web page, not the Switch server.';
    const el = await renderFlow();

    await act(async () => button(el, 'Continue with your own server').click());
    await choose(el, "It's already running");
    await type(field(el, 'Server address')!, 'https://switch-gateway.example.com');
    await choose(el, 'Sign in to this server');

    expect(el.textContent).toContain('answered with a web page, not the Switch server.');
    expect(field(el, 'Server address')).not.toBeNull();
  });

  it('asks for a full address before it will go on', async () => {
    const el = await renderFlow();

    await act(async () => button(el, 'Continue with your own server').click());
    await choose(el, "It's already running");
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

    expect(updateServer).toHaveBeenCalledWith('srv-1', 'Team', 'https://new.example.com');
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});
