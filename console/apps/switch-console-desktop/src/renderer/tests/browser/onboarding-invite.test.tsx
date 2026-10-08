/**
 * Joining a workspace from an invite link on a fresh install.
 *
 * The link names its server and carries the token, so the flow skips choosing
 * where Switch runs: a server this install knows goes straight to signing in,
 * one it does not opens the connect form at the link's address, and the
 * invitation is accepted as soon as there is an account to accept it with. A
 * refusal is shown as the server gave it, with a way on that does not need the
 * invitation.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const serverForInvite = vi.hoisted(() => vi.fn());
const acceptInvitation = vi.hoisted(() => vi.fn());
const setActiveWorkspace = vi.hoisted(() => vi.fn());
const resolveWorkspaces = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    switchServers: {
      resolveWorkspaces,
      listPendingInvitations: () => Promise.resolve({ kind: 'listed', invitations: [] }),
      listJoinableWorkspaces: () => Promise.resolve({ kind: 'listed', workspaces: [] }),
      switchCloud: () => Promise.resolve(null),
    },
    remoteHosts: { listHosts: () => Promise.resolve([]) },
  },
  events: { on: () => () => {}, emit: () => {} },
}));

vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {
    setActive: setActiveWorkspace,
    acceptInvitation,
    idOnServerInScope: () => 'ws-1',
  },
}));

const SERVER = vi.hoisted(() => ({
  id: 'srv-1',
  name: 'switch.example.com',
  gatewayUrl: 'https://switch.example.com',
  apiUrl: 'https://switch.example.com',
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    serverForInvite,
    setActive: vi.fn(),
    errorText: null,
    serverById: (id: string | null) => (id === SERVER.id ? SERVER : null),
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

vi.mock('@renderer/features/switch-servers/link-accounts-step', () => ({
  LinkAccountsStep: () => <div>Link your messaging accounts</div>,
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: vi.fn() }),
}));

vi.mock('@renderer/lib/telemetry/report', () => ({ report: vi.fn() }));

import { OnboardingFlow } from '@renderer/features/onboarding/onboarding-flow';
import { onboardingStore } from '@renderer/features/onboarding/onboarding-store';

const LINK = 'https://switch.example.com/invite#token=tok-1';

const ACME = {
  id: 'ws-1',
  serverId: 'srv-1',
  name: 'Acme',
  tenantId: 'tenant-1',
  slug: 'acme',
  role: 'member' as const,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  serverForInvite.mockReset();
  acceptInvitation.mockReset();
  resolveWorkspaces.mockReset().mockResolvedValue([ACME]);
  setActiveWorkspace.mockReset().mockResolvedValue(undefined);
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <OnboardingFlow />
      </QueryClientProvider>
    )
  );
  await settle();
  return container;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
}

async function click(el: HTMLElement, text: string): Promise<void> {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(text)
  );
  expect(found, `nothing to click named ${text}`).toBeDefined();
  await act(async () => found!.click());
  await settle();
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pasteLink(el: HTMLElement, text: string): Promise<void> {
  await click(el, 'Paste your invite link');
  await type(el.querySelector<HTMLInputElement>('#invite-link')!, text);
  await click(el, 'Continue');
}

async function signIn(el: HTMLElement): Promise<void> {
  const [email, password] = [...el.querySelectorAll<HTMLInputElement>('input')];
  await type(email!, 'someone@example.com');
  await type(password!, 'secret');
  await click(el, 'Sign in');
}

describe('joining from an invite link', () => {
  it('says what is wrong with a paste that is not an invite link', async () => {
    const el = await renderFlow();

    await pasteLink(el, 'https://switch.example.com/rooms');

    expect(el.querySelector('[role="alert"]')?.textContent).toContain('not an invitation');
    expect(serverForInvite).not.toHaveBeenCalled();
  });

  it('signs in to the server the link names and accepts the invitation', async () => {
    serverForInvite.mockResolvedValue({ kind: 'known', server: SERVER, via: 'external' });
    acceptInvitation.mockResolvedValue(ACME);
    const el = await renderFlow();

    await pasteLink(el, LINK);
    expect(serverForInvite).toHaveBeenCalledWith('https://switch.example.com');
    expect(el.textContent).toContain('Sign in to switch.example.com');

    await signIn(el);

    expect(acceptInvitation).toHaveBeenCalledWith('srv-1', 'tok-1');
    expect(setActiveWorkspace).toHaveBeenCalledWith('ws-1');
    expect(el.textContent).toContain('Link your messaging accounts');
    expect(onboardingStore.invite).toBeNull();
  });

  it('opens the connect form at the link address for a server it does not know', async () => {
    serverForInvite.mockResolvedValue({ kind: 'unknown', origin: 'https://switch.example.com' });
    const el = await renderFlow();

    await pasteLink(el, LINK);

    const fields = [...el.querySelectorAll<HTMLInputElement>('input')].map((i) => i.value);
    expect(fields).toEqual(['https://switch.example.com', 'https://switch.example.com']);
    expect(onboardingStore.invite?.token).toBe('tok-1');
  });

  it('shows why the server refused, and goes on to the workspaces without it', async () => {
    serverForInvite.mockResolvedValue({ kind: 'known', server: SERVER, via: 'external' });
    acceptInvitation.mockRejectedValue(new Error('This invitation has expired'));
    resolveWorkspaces.mockResolvedValue([ACME, { ...ACME, id: 'ws-2', name: 'Skunkworks' }]);
    const el = await renderFlow();

    await pasteLink(el, LINK);
    await signIn(el);

    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'This invitation has expired'
    );

    await click(el, 'Continue without it');

    expect(resolveWorkspaces).toHaveBeenCalledWith('srv-1');
    expect(el.textContent).toContain('Skunkworks');
    expect(onboardingStore.invite).toBeNull();
  });

  it('forgets the invite link when the user walks back to the start', async () => {
    serverForInvite.mockResolvedValue({ kind: 'known', server: SERVER, via: 'external' });
    const el = await renderFlow();

    await pasteLink(el, LINK);
    await click(el, 'Back');
    await click(el, 'Back');

    expect(el.textContent).toContain('Welcome to Switch');
    expect(onboardingStore.invite).toBeNull();
  });
});
