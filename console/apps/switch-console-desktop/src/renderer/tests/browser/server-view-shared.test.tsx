import type * as ReactQuery from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const state = vi.hoisted(() => ({
  server: null as unknown,
  running: true,
  upgrade: null as unknown,
  drift: null as unknown,
  deployedTelemetry: null as unknown,
  consent: true,
  register: null as unknown,
  start: vi.fn(),
  reset: vi.fn(),
  localStart: vi.fn(),
  localDrift: null as unknown,
  showModal: vi.fn(),
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({ params: { serverId: 'srv-1' } }),
  useNavigate: () => ({ navigate: vi.fn() }),
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: (id: string) => (args: unknown) => state.showModal(id, args),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactQuery>()),
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
}));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: { enabled: state.consent } }),
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    get servers() {
      return [state.server];
    },
    statusFor: () => ({ connected: false }),
    refreshing: new Set(),
    isUnreachable: () => false,
    isHostBlocked: () => false,
    refreshStatus: () => Promise.resolve(),
    ensureAuthConfig: () => Promise.resolve(),
    refreshServer: () => Promise.resolve(),
    error: null,
    errorDetail: null,
  },
}));
vi.mock('@renderer/features/switch-servers/remote-server-store', () => ({
  remoteServerStore: {
    isRunning: () => state.running,
    isTransitioning: () => false,
    isHostBlocked: () => false,
    registerFor: () => state.register,
    driftFor: () => state.drift,
    upgradeFor: () => state.upgrade,
    statusFor: () => ({ message: null }),
    deployedTelemetryFor: () => state.deployedTelemetry,
    start: (...args: unknown[]) => state.start(...args),
    reset: (...args: unknown[]) => state.reset(...args),
  },
}));
vi.mock('@renderer/features/switch-servers/local-server-store', () => ({
  localServerStore: {
    isRunning: true,
    isTransitioning: false,
    get drift() {
      return state.localDrift;
    },
    upgrade: null,
    message: null,
    deployedTelemetry: null,
    start: (...args: unknown[]) => state.localStart(...args),
    reset: vi.fn(),
  },
}));
vi.mock('@renderer/features/remote-hosts/host-reachability-store', () => ({
  hostReachabilityStore: {
    hydrate: () => Promise.resolve(),
    get: () => null,
    isBlocked: () => false,
  },
}));
vi.mock('@renderer/features/remote-hosts/host-unreachable-panel', () => ({
  HostUnreachablePanel: () => null,
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: { load: () => Promise.resolve() },
}));
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: { refreshRoomState: () => Promise.resolve() },
}));
vi.mock('@renderer/features/switch-servers/RemoteServerControls', () => ({
  RemoteServerControls: () => <div>remote controls</div>,
}));
vi.mock('@renderer/features/switch-servers/LocalServerControls', () => ({
  LocalServerControls: () => <div>local controls</div>,
}));
vi.mock('@renderer/features/switch-servers/shared-consoles-section', () => ({
  SharedConsolesSection: ({ sshHost }: { sshHost: string }) => (
    <div>{`consoles using ${sshHost}`}</div>
  ),
}));
vi.mock('@renderer/features/switch-servers/MessagingAppsCard', () => ({
  MessagingAppsCard: () => null,
}));
vi.mock('@renderer/features/switch-servers/server-stat-tiles', () => ({
  ServerStatTiles: () => null,
}));
vi.mock('@renderer/features/switch-servers/server-sign-in', () => ({
  ServerSignInFields: () => null,
  useServerSignIn: () => ({}),
  machineUnavailableReason: () => null,
}));

import { serverView } from '@renderer/features/switch-servers/view';
import '@renderer/index.css';

const REMOTE = {
  id: 'srv-1',
  name: 'Team Server',
  gatewayUrl: 'http://localhost:41000',
  apiUrl: 'http://localhost:41001',
  managed: true,
  managementKind: 'remote' as const,
  sshHost: 'vm-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const BOB = {
  consoleId: 'bob',
  name: 'bob@desk',
  hostAccount: 'bob',
  appVersion: '0.37.0',
  lastSeenAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
};

const SHARED = { self: 'me', consoles: [BOB], activity: [] };
const ALONE = { self: 'me', consoles: [], activity: [] };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  state.server = REMOTE;
  state.running = true;
  state.upgrade = null;
  state.drift = null;
  state.deployedTelemetry = null;
  state.consent = true;
  state.register = SHARED;
  state.start.mockReset();
  state.reset.mockReset();
  state.localStart.mockReset();
  state.localDrift = null;
  state.showModal.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render() {
  const Page = serverView.MainPanel;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Page />));
}

function button(label: RegExp): HTMLElement {
  const found = [...document.querySelectorAll('button, [role="menuitem"]')].find((b) =>
    label.test(b.textContent?.trim() ?? '')
  );
  if (!found) throw new Error(`no button matching ${label}`);
  return found as HTMLElement;
}

function dialogText(): string {
  return [...document.querySelectorAll('[role="dialog"]')].map((d) => d.textContent).join(' ');
}

function menuTrigger(): HTMLElement {
  return document.querySelector('[aria-label="Server actions"]') as HTMLElement;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

describe('the server menu', () => {
  it('offers to disconnect from or delete a remote server, which others may use', async () => {
    await render();
    await click(menuTrigger());

    await click(button(/^Disconnect or delete…$/));

    expect(state.showModal).toHaveBeenCalledWith(
      'deleteServerModal',
      expect.objectContaining({ serverId: 'srv-1' })
    );
  });

  it('offers to delete a server on this computer, which nobody else uses', async () => {
    state.server = { ...REMOTE, managementKind: 'local', sshHost: null };
    await render();
    await click(menuTrigger());

    expect(button(/^Delete server…$/)).toBeDefined();
  });

  it('offers only to disconnect from a server someone else runs', async () => {
    state.server = { ...REMOTE, managed: false, managementKind: null, sshHost: null };
    await render();
    await click(menuTrigger());

    expect(button(/^Disconnect from server…$/)).toBeDefined();
  });
});

describe('restarting from a notice', () => {
  it('asks before a retried update restarts a server others use, naming them', async () => {
    state.upgrade = { state: 'failed', from: '0.27.0', to: '0.28.0', error: 'pull failed' };
    await render();

    await click(button(/^Retry$/));

    expect(state.start).not.toHaveBeenCalled();
    expect(dialogText()).toMatch(/Restart the server on vm-1 for everyone\?/);
    expect(dialogText()).toContain('bob@desk (as bob)');
    await click(button(/^Restart for everyone$/));
    expect(state.start).toHaveBeenCalledWith('vm-1', 'Team Server');
  });

  it('updates at once from a held update, whose own button names who it reaches', async () => {
    state.upgrade = { state: 'held', from: '0.27.0', to: '0.28.0' };
    await render();

    expect(document.body.textContent).toContain('bob@desk (as bob)');
    await click(button(/^Update for everyone$/));

    expect(dialogText()).toBe('');
    expect(state.start).toHaveBeenCalledWith('vm-1', 'Team Server');
  });

  it('starts a stopped server that owes an update without asking: it reaches nobody', async () => {
    state.running = false;
    state.upgrade = { state: 'pending', from: '0.27.0', to: '0.28.0' };
    await render();

    await click(button(/^Start and update$/));

    expect(dialogText()).toBe('');
    expect(state.start).toHaveBeenCalledWith('vm-1', 'Team Server');
  });

  it('restarts at once when nobody else uses the server', async () => {
    state.register = ALONE;
    state.upgrade = { state: 'failed', from: '0.27.0', to: '0.28.0', error: 'pull failed' };
    await render();

    await click(button(/^Retry$/));

    expect(dialogText()).toBe('');
    expect(state.start).toHaveBeenCalledWith('vm-1', 'Team Server');
  });

  it('asks before restarting to apply a usage-data “no” to a server others use', async () => {
    state.consent = false;
    state.deployedTelemetry = { known: true, enabled: true };
    await render();

    await click(button(/^Restart to apply$/));

    expect(state.start).not.toHaveBeenCalled();
    expect(dialogText()).toMatch(/Restart the server on vm-1 for everyone\?/);
  });

  it('offers no restart for a “yes” a shared server would not apply over the others', async () => {
    state.consent = true;
    state.deployedTelemetry = { known: true, enabled: false };
    await render();

    expect(() => button(/^Restart to apply$/)).toThrow();
  });

  it('offers that restart when nobody else uses the server', async () => {
    state.register = ALONE;
    state.consent = true;
    state.deployedTelemetry = { known: true, enabled: false };
    await render();

    await click(button(/^Restart to apply$/));

    expect(state.start).toHaveBeenCalledWith('vm-1', 'Team Server');
  });

  it('restarts a server on this computer without asking anyone', async () => {
    state.server = { ...REMOTE, managementKind: 'local', sshHost: null };
    state.register = null;
    state.localDrift = { deployed: 'dev-checkout', expected: '0.28.0', direction: 'unknown' };
    await render();

    await click(button(/^Restart to update$/));

    expect(dialogText()).toBe('');
    expect(state.localStart).toHaveBeenCalled();
  });

  it('asks before restarting a remote server others use to fix a version mismatch', async () => {
    state.drift = { deployed: 'dev-checkout', expected: '0.28.0', direction: 'unknown' };
    await render();

    await click(button(/^Restart to update$/));

    expect(state.start).not.toHaveBeenCalled();
    expect(dialogText()).toMatch(/Restart the server on vm-1 for everyone\?/);
  });
});

describe('the rest of a shared server’s page', () => {
  it('lists the Consoles using a remote server', async () => {
    await render();

    expect(document.body.textContent).toContain('consoles using vm-1');
  });

  it('lists none for a server on this computer', async () => {
    state.server = { ...REMOTE, managementKind: 'local', sshHost: null };
    await render();

    expect(document.body.textContent).not.toContain('consoles using');
  });

  it('says a reset deletes it for everyone, naming them, and resets that host', async () => {
    await render();

    await click(button(/^Reset…$/));

    expect(dialogText()).toContain('everyone who uses it');
    expect(dialogText()).toContain('bob@desk (as bob)');
    await click(button(/^Reset and delete all agents$/));
    expect(state.reset).toHaveBeenCalledWith('vm-1');
  });
});
