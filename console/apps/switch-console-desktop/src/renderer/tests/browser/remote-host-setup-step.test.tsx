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
  hosts: [{ sshHost: 'vm-1', name: 'Team VM' }] as { sshHost: string; name: string }[],
  probe: null as unknown,
  status: null as unknown,
  transitioning: false,
  running: false,
  register: null as unknown,
  connect: vi.fn(),
  start: vi.fn(),
  cancelWait: vi.fn(),
  loadRegister: vi.fn(),
  probeHost: vi.fn(async (_sshHost: unknown) => {}),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { remoteHosts: { listHosts: () => Promise.resolve(state.hosts) } },
  events: { on: () => () => {} },
}));
vi.mock('@renderer/features/remote-hosts/host-reachability-notice', () => ({
  HostReachabilityNotice: () => null,
}));
vi.mock('@renderer/features/switch-servers/remote-server-store', () => ({
  remoteServerStore: {
    init: () => Promise.resolve(),
    checkDocker: () => Promise.resolve(),
    probe: (sshHost: string) => state.probeHost(sshHost),
    isHostBlocked: () => false,
    isRunning: () => state.running,
    isTransitioning: () => state.transitioning,
    dockerFor: () => ({ available: true, version: '27.0.0' }),
    statusFor: () => state.status,
    logsFor: () => [],
    probeFor: () => state.probe,
    isProbing: () => false,
    registerFor: () => state.register,
    loadRegister: (...args: unknown[]) => state.loadRegister(...args),
    connect: (...args: unknown[]) => state.connect(...args),
    start: (...args: unknown[]) => state.start(...args),
    cancelWait: (...args: unknown[]) => state.cancelWait(...args),
    error: null,
    errorDetail: null,
  },
}));

import { RemoteHostSetupStep } from '@renderer/features/switch-servers/AddServerModal';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import '@renderer/index.css';

const bob = {
  name: 'bob@desk',
  hostAccount: 'bob',
  action: 'starting' as const,
  heldForSeconds: 40,
  expiresInSeconds: 80,
};

function status(overrides: Record<string, unknown> = {}) {
  return {
    sshHost: 'vm-1',
    phase: 'stopped',
    upgrade: null,
    serverId: null,
    version: '0.28.0',
    deployedVersion: null,
    drift: null,
    checkoutBuild: null,
    deployedTelemetry: null,
    message: null,
    error: null,
    notice: null,
    recordWarning: null,
    waitingFor: null,
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  state.hosts = [{ sshHost: 'vm-1', name: 'Team VM' }];
  state.probe = { kind: 'absent', busy: null };
  state.status = status();
  state.transitioning = false;
  state.running = false;
  state.register = { self: 'me', consoles: [], activity: [] };
  state.connect.mockReset();
  state.start.mockReset();
  state.cancelWait.mockReset();
  state.loadRegister.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <Dialog open>
        <DialogContent>
          <RemoteHostSetupStep
            onBack={() => {}}
            onDone={() => {}}
            onClose={() => {}}
            onRegistered={null}
          />
        </DialogContent>
      </Dialog>
    )
  );
  // The host list arrives on the next tick; with one host it is chosen.
  await act(async () => {});
}

function text(): string {
  return document.querySelector('[role="dialog"]')?.textContent ?? '';
}

/** Matched on its text; the primary button's is followed by its shortcut, so
 * it is matched by how it starts. */
function button(label: RegExp): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) =>
    label.test(b.textContent?.trim() ?? '')
  );
  if (!found) throw new Error(`no button matching ${label}`);
  return found as HTMLButtonElement;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

describe('what the step offers for what the host has', () => {
  it('offers Start on an empty host', async () => {
    await render();

    await click(button(/^Start/));

    expect(state.start).toHaveBeenCalledWith('vm-1', 'Team VM Switch server');
  });

  it('offers Connect for a running server on this Console’s version', async () => {
    state.probe = {
      kind: 'present',
      running: true,
      deployedVersion: '0.28.0',
      shared: true,
      drift: null,
      busy: null,
    };
    await render();

    await click(button(/^Connect/));

    expect(state.connect).toHaveBeenCalledWith('vm-1', 'Team VM Switch server');
  });

  it('offers Update and connect for an older one, naming who else the update reaches', async () => {
    state.probe = {
      kind: 'present',
      running: true,
      deployedVersion: '0.27.0',
      shared: true,
      drift: { deployed: '0.27.0', expected: '0.28.0', direction: 'upgrade' },
      busy: null,
    };
    state.register = {
      self: 'me',
      consoles: [
        {
          consoleId: 'bob',
          name: 'bob@desk',
          hostAccount: 'bob',
          appVersion: '0.37.0',
          lastSeenAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        },
      ],
      activity: [],
    };
    await render();

    expect(state.loadRegister).toHaveBeenCalledWith('vm-1');
    expect(text()).toContain('bob@desk (as bob)');
    await click(button(/^Update and connect/));

    expect(state.connect).toHaveBeenCalledWith('vm-1', 'Team VM Switch server');
  });

  it('says Updating… while that update runs', async () => {
    state.probe = {
      kind: 'present',
      running: true,
      deployedVersion: '0.27.0',
      shared: true,
      drift: { deployed: '0.27.0', expected: '0.28.0', direction: 'upgrade' },
      busy: null,
    };
    state.transitioning = true;
    state.status = status({ phase: 'starting', message: 'Updating the server…' });
    await render();

    expect(button(/^Updating…/)).toBeDefined();
  });
});

describe('another Console changing the server', () => {
  it('says who is changing it, and that Start will wait for them', async () => {
    state.probe = { kind: 'absent', busy: bob };
    await render();

    expect(text()).toContain(
      'bob@desk (as bob) is starting this server right now. Starting or connecting here waits ' +
        'until they are done.'
    );
  });

  it('says it for a server that is there too', async () => {
    state.probe = {
      kind: 'present',
      running: false,
      deployedVersion: '0.28.0',
      shared: true,
      drift: null,
      busy: { ...bob, action: 'stopping' },
    };
    await render();

    expect(text()).toContain('bob@desk (as bob) is stopping this server right now.');
  });

  it('stops saying it once this Console is the one starting', async () => {
    state.probe = { kind: 'absent', busy: bob };
    state.transitioning = true;
    state.status = status({ phase: 'starting', message: 'Starting containers…' });
    await render();

    expect(text()).not.toContain('is starting this server right now');
  });

  it('offers Stop waiting while it waits for them, and stops waiting when asked', async () => {
    state.transitioning = true;
    state.status = status({
      phase: 'starting',
      message: 'Waiting for bob@desk (as bob) to finish starting the server…',
      waitingFor: bob,
    });
    await render();

    expect(text()).toContain('Waiting for bob@desk (as bob) to finish starting the server…');
    await click(button(/^Stop waiting$/));

    expect(state.cancelWait).toHaveBeenCalledWith('vm-1');
  });

  it('offers Back, not Stop waiting, during a start that is not waiting on anyone', async () => {
    // The start belongs to the store, which outlives the page, so leaving it
    // abandons nothing; only a wait for another Console can be called off.
    state.transitioning = true;
    state.status = status({ phase: 'starting', message: 'Starting containers…' });
    await render();

    expect(() => button(/^Stop waiting$/)).toThrow();
    expect(button(/^Back$/).disabled).toBe(false);
  });
});

describe('the rest of the step', () => {
  it('says it is looking before the host has answered', async () => {
    state.probe = null;
    await render();

    expect(text()).toContain('Looking for a Switch server on vm-1…');
  });

  it('says Connecting… while it joins', async () => {
    state.probe = {
      kind: 'present',
      running: true,
      deployedVersion: '0.28.0',
      shared: true,
      drift: null,
      busy: null,
    };
    state.transitioning = true;
    state.status = status({ phase: 'starting', message: 'Connecting to vm-1…' });
    await render();

    expect(button(/^Connecting…/)).toBeDefined();
  });

  it('ends on the server it started or joined once it is running', async () => {
    state.running = true;
    state.status = status({ phase: 'running', serverId: 'srv-1' });
    const onDone = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <Dialog open>
          <DialogContent>
            <RemoteHostSetupStep
              onBack={() => {}}
              onDone={onDone}
              onClose={() => {}}
              onRegistered={null}
            />
          </DialogContent>
        </Dialog>
      )
    );
    await act(async () => {});

    expect(text()).toContain('Server is running on vm-1');
    await click(button(/^Done/));

    expect(onDone).toHaveBeenCalledWith('srv-1');
  });
});

describe('a host with nothing safe to do from this account', () => {
  it('looks at the host again when asked to', async () => {
    state.probe = {
      kind: 'unshared',
      running: true,
      ownerDir: '/home/alice/.switchdash/switch-server',
      message: 'The Switch server on vm-1 was set up from another account.',
    };
    await render();
    state.probeHost.mockClear();

    await click(button(/^Check again$/));

    expect(state.probeHost).toHaveBeenCalledWith('vm-1');
  });
});
