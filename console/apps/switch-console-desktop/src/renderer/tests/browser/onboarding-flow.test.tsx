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
const setActive = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    addServer,
    setActive,
    errorText: null,
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

vi.mock('@renderer/lib/telemetry/report', () => ({ report: vi.fn() }));

import { OnboardingFlow } from '@renderer/features/onboarding/onboarding-flow';
import { onboardingStore } from '@renderer/features/onboarding/onboarding-store';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  addServer.mockReset();
  setActive.mockReset();
  navigate.mockReset();
  onboardingStore.reset();
});

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

  it('leaves the managed remote-host path out, having no host to offer', async () => {
    // It needs a host onboarded over SSH, and a fresh install has none — the
    // card would lead to an empty list every time it was taken.
    const el = await renderFlow();

    await act(async () => button(el, 'Continue with your own server').click());

    expect(el.textContent).not.toContain('remote host');
  });

  it('goes back from the question to the welcome', async () => {
    const el = await renderFlow();

    await act(async () => button(el, 'Continue with your own server').click());
    await act(async () =>
      el.querySelector<HTMLButtonElement>('[aria-label="Previous page"]')!.click()
    );

    expect(el.textContent).toContain('Welcome to Switch');
  });

  it('asks for the addresses, and not for a name, on the connect page', async () => {
    // Someone connecting their only server has nothing to tell it apart from,
    // so the field is a question asked for the list's benefit rather than
    // theirs.
    const el = await renderFlow();

    await act(async () => button(el, 'Continue with your own server').click());
    await choose(el, "It's already running");

    expect(el.textContent).toContain('Connect to your server');
    expect(field(el, 'Gateway URL')).not.toBeNull();
    expect(field(el, 'API URL')).not.toBeNull();
    expect(field(el, 'Name')).toBeNull();
  });

  it('names the server after its gateway, having never asked', async () => {
    // The page that skips the question still has to produce a name: an
    // unnamed row in the sidebar would be the cost of the shortcut.
    addServer.mockResolvedValue({
      id: 'srv-1',
      name: 'switch.example.com',
      gatewayUrl: 'https://switch.example.com',
      apiUrl: 'https://switch.example.com:8000',
    });
    const el = await renderFlow();

    await act(async () => button(el, 'Continue with your own server').click());
    await choose(el, "It's already running");
    await type(field(el, 'Gateway URL')!, 'https://switch.example.com');
    await type(field(el, 'API URL')!, 'https://switch.example.com:8000');
    await choose(el, 'Sign in to this server');

    expect(addServer).toHaveBeenCalledWith(
      'switch.example.com',
      'https://switch.example.com',
      'https://switch.example.com:8000'
    );
  });

  it('keeps the flow on screen after the server is added, for the sign-in still to come', async () => {
    // The server exists from here on, which is exactly when the window would
    // otherwise decide onboarding is over and take the remaining pages away.
    addServer.mockResolvedValue({
      id: 'srv-1',
      name: 'switch.example.com',
      gatewayUrl: 'https://switch.example.com',
      apiUrl: 'https://switch.example.com:8000',
    });
    const el = await renderFlow();

    await act(async () => button(el, 'Continue with your own server').click());
    await choose(el, "It's already running");
    await type(field(el, 'Gateway URL')!, 'https://switch.example.com');
    await type(field(el, 'API URL')!, 'https://switch.example.com:8000');
    await choose(el, 'Sign in to this server');

    expect(onboardingStore.inProgress).toBe(true);
    expect(onboardingStore.page).toBe('signIn');
  });
});
