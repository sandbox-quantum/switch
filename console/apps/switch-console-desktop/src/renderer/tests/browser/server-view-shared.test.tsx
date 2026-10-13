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
