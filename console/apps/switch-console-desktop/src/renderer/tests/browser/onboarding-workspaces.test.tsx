/**
 * Choosing a workspace on a server you have just signed in to.
 *
 * The interesting behaviour is not the list — it is what the pages do with the
 * three answers the server can give. None, one and several each lead somewhere
 * different, being asked and failing is not the same as being asked and told
 * "none", and the sections the server cannot answer for at all are absent
 * rather than drawn empty.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveWorkspaces = vi.hoisted(() => vi.fn());
const createWorkspace = vi.hoisted(() => vi.fn());
const setActiveWorkspace = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { switchServers: { resolveWorkspaces } },
  events: { on: () => () => {}, emit: () => {} },
}));

vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {
    setActive: setActiveWorkspace,
    create: createWorkspace,
    idOnServerInScope: () => 'ws-1',
  },
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { setActive: vi.fn(), errorText: null },
}));

// The last page of the flow, and not what these tests are about — stubbed so
// reaching it is a fact the test can assert without dragging in the bridge
// reads behind it.
vi.mock('@renderer/features/switch-servers/link-accounts-step', () => ({
  LinkAccountsStep: () => <div>Link your messaging accounts</div>,
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: vi.fn() }),
}));

vi.mock('@renderer/lib/telemetry/report', () => ({ report: vi.fn() }));

import { OnboardingFlow } from '@renderer/features/onboarding/onboarding-flow';
import { onboardingStore } from '@renderer/features/onboarding/onboarding-store';

const SERVER = {
  id: 'srv-1',
  name: 'switch.example.com',
  gatewayUrl: 'https://switch.example.com',
  apiUrl: 'https://switch.example.com:8000',
};

function workspace(id: string, name: string) {
  return {
    id,
    serverId: 'srv-1',
    name,
    tenantId: `tenant-${id}`,
    slug: name.toLowerCase(),
    role: 'member' as const,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  resolveWorkspaces.mockReset();
  createWorkspace.mockReset();
  setActiveWorkspace.mockReset().mockResolvedValue(undefined);
  onboardingStore.reset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

/** The flow, opened at the page that follows a successful sign-in. */
async function renderAtPickWorkspace(): Promise<HTMLDivElement> {
  onboardingStore.connected(SERVER as never);
  onboardingStore.goTo('pickWorkspace');

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

async function typeName(el: HTMLElement, value: string): Promise<void> {
  const input = el.querySelector('input');
  expect(input, 'no name field').not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('picking a workspace after signing in', () => {
  it('lists the workspaces the account is a member of', async () => {
    resolveWorkspaces.mockResolvedValue([
      workspace('ws-1', 'Acme'),
      workspace('ws-2', 'Skunkworks'),
    ]);

    const el = await renderAtPickWorkspace();

    expect(resolveWorkspaces).toHaveBeenCalledWith('srv-1');
    expect(el.textContent).toContain('Pick a workspace');
    expect(el.textContent).toContain('Acme');
    expect(el.textContent).toContain('Skunkworks');
    expect(el.textContent).toContain('Create a new workspace');
  });

  it('leaves out the join and invite rows the server cannot answer for', async () => {
    // The design offers workspaces open to you by email domain, and invitations
    // waiting for your address. A Switch server records neither, so an empty
    // section would be a claim it never made.
    resolveWorkspaces.mockResolvedValue([
      workspace('ws-1', 'Acme'),
      workspace('ws-2', 'Skunkworks'),
    ]);

    const el = await renderAtPickWorkspace();

    expect(el.textContent).not.toContain('Join');
    expect(el.textContent).not.toContain('Accept');
    expect(el.textContent).not.toContain('invited you');
    expect(el.textContent).not.toContain('domain');
  });

  it('does not ask a question with one answer', async () => {
    resolveWorkspaces.mockResolvedValue([workspace('ws-1', 'Acme')]);

    const el = await renderAtPickWorkspace();

    expect(setActiveWorkspace).toHaveBeenCalledWith('ws-1');
    expect(onboardingStore.page).toBe('linkAccounts');
    expect(el.textContent).toContain('Link your messaging accounts');
  });

  it('goes straight to creating one when the account is in none', async () => {
    resolveWorkspaces.mockResolvedValue([]);

    const el = await renderAtPickWorkspace();

    expect(onboardingStore.page).toBe('createWorkspace');
    expect(el.textContent).toContain('Create your workspace');
    // Nothing behind it: the picker had no list to return to. The arrow stays
    // in the tab order and says as much in its own label, so it is matched on
    // the start of one.
    const back = el.querySelector<HTMLButtonElement>('[aria-label^="Previous page"]')!;
    expect(back.getAttribute('aria-disabled')).toBe('true');
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Back');
  });

  it('says the server could not be asked, rather than treating it as no workspaces', async () => {
    // Conflating the two would offer to create a second workspace to someone
    // who already has one.
    resolveWorkspaces.mockRejectedValue(new Error('gateway unreachable'));

    const el = await renderAtPickWorkspace();

    expect(el.textContent).toContain('switch.example.com');
    expect(el.textContent).toContain('Retry');
    expect(onboardingStore.page).toBe('pickWorkspace');
    expect(el.textContent).not.toContain('Create your workspace');
  });

  it('creates a workspace and carries on into it', async () => {
    resolveWorkspaces.mockResolvedValue([]);
    createWorkspace.mockResolvedValue(workspace('ws-9', 'Acme'));

    const el = await renderAtPickWorkspace();
    await typeName(el, '  Acme  ');
    await click(el, 'Create workspace');

    expect(createWorkspace).toHaveBeenCalledWith('srv-1', 'Acme');
    expect(setActiveWorkspace).toHaveBeenCalledWith('ws-9');
    expect(onboardingStore.page).toBe('linkAccounts');
  });

  it('keeps the form and says why when the name is refused', async () => {
    resolveWorkspaces.mockResolvedValue([]);
    createWorkspace.mockRejectedValue(new Error('That name is already taken.'));

    const el = await renderAtPickWorkspace();
    await typeName(el, 'Acme');
    await click(el, 'Create workspace');

    expect(el.textContent).toContain('already taken');
    expect(onboardingStore.page).toBe('createWorkspace');
  });
});
