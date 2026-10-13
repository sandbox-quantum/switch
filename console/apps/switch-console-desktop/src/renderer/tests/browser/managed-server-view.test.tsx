import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  localStatus: null as unknown,
  remoteStatus: null as unknown,
  register: null as unknown,
  startedAt: null as string | null,
  activity: [] as unknown[],
  localStart: vi.fn(),
  localStop: vi.fn(),
  useAnotherPort: vi.fn((_port: number) => Promise.resolve()),
  remoteStart: vi.fn(),
  remoteStop: vi.fn(),
  remoteReset: vi.fn(),
  cancelWait: vi.fn(),
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({ params: { serverId: 'srv-1' } }),
  useNavigate: () => ({ navigate: vi.fn() }),
}));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: {
    localSwitchServer: {
      startedAt: () => Promise.resolve(state.startedAt),
      activity: () => Promise.resolve(state.activity),
    },
    remoteSwitchServer: { startedAt: () => Promise.resolve(state.startedAt) },
  },
}));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: { enabled: true } }),
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {
    onServer: () => [
      { id: 'w1', name: 'Default', tenantId: 't1' },
      { id: 'w2', name: 'Scratch', tenantId: 't2' },
    ],
  },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    loaded: true,
    get servers() {
      return [state.server];
    },
  },
}));
vi.mock('@renderer/features/switch-servers/local-server-store', () => ({
  localServerStore: {
    get status() {
      return state.localStatus;
    },
    get message() {
      return (state.localStatus as { message: string | null } | null)?.message ?? null;
    },
    docker: null,
    busy: false,
    logs: [],
    error: null,
    errorDetail: null,
    checkoutBuild: null,
    checkDocker: () => Promise.resolve(),
    start: (...args: unknown[]) => state.localStart(...args),
    stop: (...args: unknown[]) => state.localStop(...args),
    useAnotherPort: (port: number) => state.useAnotherPort(port),
    reset: vi.fn(),
    setCheckoutBuild: vi.fn(),
  },
}));
vi.mock('@renderer/features/switch-servers/remote-server-store', () => ({
  remoteServerStore: {
    statusFor: () => state.remoteStatus,
    dockerFor: () => null,
    registerFor: () => state.register,
    logsFor: () => [],
    isBusy: () => false,
    isHostBlocked: () => false,
    error: null,
    errorDetail: null,
    init: () => Promise.resolve(),
    checkDocker: () => Promise.resolve(),
    loadRegister: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    start: (...args: unknown[]) => state.remoteStart(...args),
    stop: (...args: unknown[]) => state.remoteStop(...args),
    reset: (...args: unknown[]) => state.remoteReset(...args),
    cancelWait: (...args: unknown[]) => state.cancelWait(...args),
  },
}));
vi.mock('@renderer/features/remote-hosts/host-reachability-store', () => ({
  hostReachabilityStore: {
    hydrate: () => Promise.resolve(),
    get: () => null,
    isBlocked: () => false,
    isRetrying: () => false,
    retry: vi.fn(),
  },
}));

import { managedServerView } from '@renderer/features/switch-servers/managed-server-view';
import '@renderer/index.css';

const LOCAL = {
  id: 'srv-1',
  name: 'Local dev',
  gatewayUrl: 'http://localhost:41000',
  apiUrl: 'http://localhost:41001',
  managed: true,
  managementKind: 'local' as const,
  sshHost: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const REMOTE = { ...LOCAL, name: 'Dev VM', managementKind: 'remote' as const, sshHost: 'vm-1' };

function status(patch: Record<string, unknown>) {
  return {
    phase: 'running',
    checked: true,
    upgrade: null,
    serverId: 'srv-1',
    version: '0.30.0',
    deployedVersion: '0.30.0',
    drift: null,
    checkoutBuild: null,
    deployedTelemetry: null,
    message: null,
    error: null,
    failedTo: null,
    notice: null,
    recordWarning: null,
    waitingFor: null,
    sshHost: 'vm-1',
    ...patch,
  };
}

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
  state.server = LOCAL;
  state.localStatus = status({});
  state.remoteStatus = status({});
  state.register = ALONE;
  state.startedAt = null;
  state.activity = [];
  for (const fn of [
    state.localStart,
    state.localStop,
    state.useAnotherPort,
    state.remoteStart,
    state.remoteStop,
    state.remoteReset,
    state.cancelWait,
  ]) {
    fn.mockClear();
  }
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render() {
  const Page = managedServerView.MainPanel;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>
    )
  );
  // Let the queries settle.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function text(): string {
  return container?.textContent ?? '';
}

function button(label: RegExp): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) =>
    label.test(b.textContent?.trim() ?? '')
  );
  if (!found) throw new Error(`no button matching ${label}`);
  return found;
}

function hasButton(label: RegExp): boolean {
  return [...document.querySelectorAll('button')].some((b) =>
    label.test(b.textContent?.trim() ?? '')
  );
}

function messageBoxes(): Element[] {
  return [...(container?.querySelectorAll('[role="status"], [role="alert"]') ?? [])];
}

function dialogText(): string {
  return [...document.querySelectorAll('[role="dialog"]')].map((d) => d.textContent).join(' ');
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

describe('a running server', () => {
  it('says it is running and up to date, offers Restart and Stop, and has no message', async () => {
    state.startedAt = new Date().toISOString();
    await render();

    expect(text()).toContain('Running');
    expect(text()).toContain('0.30.0 · up to date');
    expect(text()).toContain('Running since');
    expect(text()).toContain('This computer · runs with Docker');
    expect(hasButton(/^Restart$/)).toBe(true);
    expect(hasButton(/^Stop$/)).toBe(true);
    expect(messageBoxes()).toHaveLength(0);
  });

  it('lists what has happened to it, most recent first', async () => {
    state.activity = [
      { at: new Date().toISOString(), action: 'started', detail: null },
      { at: new Date(Date.now() - 86_400_000).toISOString(), action: 'updated', detail: '0.30.0' },
    ];
    await render();

    expect(text()).toContain('Recent activity');
    expect(text()).toMatch(/Started.*You · just now.*Updated to 0\.30\.0.*You · yesterday/);
  });
});

describe('a server that is not running', () => {
  it('names the workspaces that live on it and starts it from the one primary button', async () => {
    state.localStatus = status({ phase: 'stopped' });
    await render();

    expect(text()).toContain('Not running');
    expect(text()).toContain('Agents and rooms in Default and Scratch live here.');
    expect(text()).toContain('Default, Scratch · unavailable');
    await click(button(/^Start$/));
    expect(state.localStart).toHaveBeenCalled();
  });

  it('says when it last ran', async () => {
    state.localStatus = status({ phase: 'stopped' });
    state.activity = [
      { at: new Date(Date.now() - 2 * 86_400_000).toISOString(), action: 'stopped', detail: null },
    ];
    await render();

    expect(text()).toContain('Last running2 days ago');
  });
});

describe('a server that is starting', () => {
  it('shows what it is doing, warns a first pull is slow, and offers nothing to press', async () => {
    state.localStatus = status({ phase: 'starting', message: 'Pulling images…' });
    await render();

    expect(text()).toContain('Pulling images…');
    expect(text()).toContain('This can take a few minutes the first time.');
    expect(text()).toContain('available once running');
    expect(button(/^Stop$/).disabled).toBe(true);
  });
});

describe('a server that failed to start', () => {
  it('shows the line that says why, what to do, and moves the port when asked', async () => {
    state.localStatus = status({
      phase: 'error',
      error:
        'Error response from daemon: driver failed\ngateway: bind 0.0.0.0:8000: address already in use',
    });
    await render();

    expect(text()).toContain('Failed to start');
    expect(text()).toContain('gateway: bind 0.0.0.0:8000: address already in use');
    expect(text()).toContain('Another program is using port 8000.');
    await click(button(/^Use another port$/));
    expect(state.useAnotherPort).toHaveBeenCalledWith(8000);
  });

  it('offers no way to move the port of a server on another host', async () => {
    state.server = REMOTE;
    state.remoteStatus = status({
      phase: 'error',
      error: 'gateway: bind 0.0.0.0:8000: address already in use',
    });
    await render();

    expect(hasButton(/^Use another port$/)).toBe(false);
    expect(hasButton(/^Try again$/)).toBe(true);
  });

  it('offers nothing to press for a server newer than this app', async () => {
    state.localStatus = status({
      phase: 'error',
      deployedVersion: '0.31.0',
      drift: { deployed: '0.31.0', expected: '0.30.0', direction: 'downgrade' },
    });
    await render();

    expect(text()).toContain('This server is newer than Switch Console');
    expect(hasButton(/^(Start|Try again)$/)).toBe(false);
  });
});

describe('a stop that failed', () => {
  it('says it could not stop, and offers to stop again rather than to start', async () => {
    state.server = REMOTE;
    state.remoteStatus = status({
      phase: 'error',
      failedTo: 'stop',
      error: 'docker compose down failed: Container switch Stopping',
    });
    await render();

    expect(text()).toContain("Couldn't stop");
    expect(text()).not.toContain('Failed to start');
    expect(hasButton(/^(Start|Try again)$/)).toBe(false);
    await click(button(/^Stop again$/));
    expect(state.remoteStop).toHaveBeenCalledWith('vm-1');
  });
});

describe('a shared remote server', () => {
  beforeEach(() => {
    state.server = REMOTE;
    state.register = SHARED;
  });

  it('says who else uses it', async () => {
    await render();
    expect(text()).toContain('Shared with bob@desk.');
    expect(text()).toContain('vm-1 · runs with Docker');
  });

  it('asks before stopping it, naming who it reaches', async () => {
    await render();
    await click(button(/^Stop$/));

    expect(state.remoteStop).not.toHaveBeenCalled();
    expect(dialogText()).toContain('bob@desk');
  });

  it('asks before restarting it', async () => {
    await render();
    await click(button(/^Restart$/));

    expect(state.remoteStart).not.toHaveBeenCalled();
    expect(dialogText()).toContain('bob@desk');
  });

  it('updates at once from a held update, whose message names who it reaches', async () => {
    state.remoteStatus = status({
      upgrade: { state: 'held', from: '0.29.0', to: '0.30.0' },
      deployedVersion: '0.29.0',
    });
    await render();

    expect(text()).toContain('Update ready');
    expect(text()).toContain('switch-core 0.30.0 is ready');
    expect(text()).toContain('bob@desk used it recently');
    expect(text()).toContain('0.29.0 → 0.30.0');
    await click(button(/^Update now$/));
    expect(state.remoteStart).toHaveBeenCalledWith('vm-1', 'Dev VM');
  });

  it('asks before a retried update restarts it for the others', async () => {
    state.remoteStatus = status({
      upgrade: { state: 'failed', from: '0.29.0', to: '0.30.0', error: 'backup failed' },
    });
    await render();

    expect(text()).toContain('backup failed');
    await click(button(/^Try again$/));
    expect(state.remoteStart).not.toHaveBeenCalled();
    expect(dialogText()).toContain('bob@desk');
  });

  it('shows what other Consoles did to it', async () => {
    state.remoteStatus = status({
      notice: 'bob@desk stopped this server.',
      recordWarning: 'Could not record that you started it.',
    });
    await render();

    expect(text()).toContain('bob@desk stopped this server.');
    expect(text()).toContain('Could not record that you started it.');
  });

  it('says a reset deletes it for everyone, naming them, and resets that host', async () => {
    await render();
    await click(button(/^Reset…$/));

    expect(dialogText()).toContain('bob@desk');
  });
});

describe('a remote server nobody else uses', () => {
  beforeEach(() => {
    state.server = REMOTE;
    state.register = ALONE;
  });

  it('stops at once', async () => {
    await render();
    await click(button(/^Stop$/));
    expect(state.remoteStop).toHaveBeenCalledWith('vm-1');
  });

  it('says who it is waiting for, and stops waiting when asked', async () => {
    state.remoteStatus = status({
      phase: 'running',
      message: 'Waiting for bob@desk (as bob) to finish starting the server…',
      waitingFor: {
        name: 'bob@desk',
        hostAccount: 'bob',
        action: 'starting',
        heldForSeconds: 10,
        expiresInSeconds: 50,
      },
    });
    await render();

    expect(text()).toContain('Waiting for bob@desk (as bob) to finish starting the server…');
    await click(button(/^Stop waiting$/));
    expect(state.cancelWait).toHaveBeenCalledWith('vm-1');
  });
});
