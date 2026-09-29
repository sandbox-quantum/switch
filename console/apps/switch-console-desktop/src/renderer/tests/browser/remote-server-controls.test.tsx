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

function defaultStatus() {
  return {
    sshHost: 'vm-1',
    phase: 'running' as const,
    upgrade: null,
    serverId: 'srv-1',
    version: '0.37.0',
    deployedVersion: '0.37.0',
    drift: null,
    checkoutBuild: null,
    deployedTelemetry: null,
    message: null as string | null,
    error: null as string | null,
    notice: null as string | null,
    recordWarning: null as string | null,
    waitingFor: null as unknown,
  };
}

const state = vi.hoisted(() => ({
  register: null as unknown,
  status: undefined as unknown,
  hostBlocked: false,
  transitioning: false,
  running: true,
  docker: null as unknown,
  drift: null as unknown,
  logs: [] as string[],
  error: null as string | null,
  errorDetail: null as string | null,
  start: vi.fn(),
  stop: vi.fn(),
  cancelWait: vi.fn(),
}));

vi.mock('@renderer/features/switch-servers/remote-server-store', () => ({
  remoteServerStore: {
    init: () => Promise.resolve(),
    checkDocker: () => Promise.resolve(),
    loadRegister: () => Promise.resolve(),
    registerFor: () => state.register,
    statusFor: () => state.status,
    isHostBlocked: () => state.hostBlocked,
    isTransitioning: () => state.transitioning,
    isRunning: () => state.running,
    dockerFor: () => state.docker,
    driftFor: () => state.drift,
    logsFor: () => state.logs,
    get error() {
      return state.error;
    },
    get errorDetail() {
      return state.errorDetail;
    },
    start: (...args: unknown[]) => state.start(...args),
    stop: (...args: unknown[]) => state.stop(...args),
    cancelWait: (...args: unknown[]) => state.cancelWait(...args),
  },
}));

/**
 * A remote stack is shared by everyone with access to its host (CHOO-2893):
 * the controls say so, surface the host's own notices, and gate Stop/Restart
 * behind a confirmation once someone else has used it lately.
 */
import { RemoteServerControls } from '@renderer/features/switch-servers/RemoteServerControls';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const OTHER_CONSOLE = {
  consoleId: 'bob',
  name: 'bob@desk',
  hostAccount: 'bob',
  appVersion: '0.37.0',
  lastSeenAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
};

beforeEach(() => {
  state.register = { self: 'me', consoles: [], activity: [] };
  state.status = defaultStatus();
  state.hostBlocked = false;
  state.transitioning = false;
  state.running = true;
  state.docker = null;
  state.drift = null;
  state.logs = [];
  state.error = null;
  state.errorDetail = null;
  state.start.mockReset();
  state.stop.mockReset();
  state.cancelWait.mockReset();
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
  await act(async () => root!.render(<RemoteServerControls sshHost="vm-1" name="Team Server" />));
}

function button(label: RegExp): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) =>
    label.test(b.textContent ?? '')
  );
  if (!found) throw new Error(`no button matching ${label}`);
  return found as HTMLButtonElement;
}

function dialogText(): string {
  return document.querySelector('[role="dialog"]')?.textContent ?? '';
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

describe('sharing notice', () => {
  it('says who else has used the server recently', async () => {
    state.register = { self: 'me', consoles: [OTHER_CONSOLE], activity: [] };
    await render();

    expect(document.body.textContent).toContain(
      'Shared with bob@desk. Stopping or restarting it affects them too.'
    );
  });

  it('says nothing when nobody else has used it', async () => {
    state.register = { self: 'me', consoles: [], activity: [] };
    await render();

    expect(document.body.textContent).not.toContain('Shared with');
  });
});

describe('host notices', () => {
  it('shows the status notice as an alert', async () => {
    state.status = { ...defaultStatus(), notice: 'Someone else started this stack.' };
    await render();

    expect(document.body.textContent).toContain('Someone else started this stack.');
  });

  it('shows the record warning as an alert', async () => {
    state.status = {
      ...defaultStatus(),
      recordWarning: 'Could not record that this Console started it.',
    };
    await render();

    expect(document.body.textContent).toContain('Could not record that this Console started it.');
  });
});

describe('stopping or restarting a shared stack', () => {
  it('asks before stopping it when others have used it lately', async () => {
    state.register = { self: 'me', consoles: [OTHER_CONSOLE], activity: [] };
    await render();

    await click(button(/^Stop$/));

    expect(state.stop).not.toHaveBeenCalled();
    expect(dialogText()).toMatch(/Stop the server on vm-1 for everyone\?/);

    await click(button(/Stop for everyone/));

    expect(state.stop).toHaveBeenCalledWith('vm-1');
  });

  it('asks before restarting it when others have used it lately', async () => {
    state.register = { self: 'me', consoles: [OTHER_CONSOLE], activity: [] };
    await render();

    await click(button(/^Restart$/));

    expect(state.start).not.toHaveBeenCalled();
    expect(dialogText()).toMatch(/Restart the server on vm-1 for everyone\?/);

    await click(button(/Restart for everyone/));

    expect(state.start).toHaveBeenCalledWith('vm-1', 'Team Server');
  });

  it('stops at once when nobody else has used it', async () => {
    state.register = { self: 'me', consoles: [], activity: [] };
    await render();

    await click(button(/^Stop$/));

    expect(state.stop).toHaveBeenCalledWith('vm-1');
    expect(dialogText()).toBe('');
  });

  it('restarts at once when nobody else has used it', async () => {
    state.register = { self: 'me', consoles: [], activity: [] };
    await render();

    await click(button(/^Restart$/));

    expect(state.start).toHaveBeenCalledWith('vm-1', 'Team Server');
    expect(dialogText()).toBe('');
  });
});

describe('a stack ahead of this build', () => {
  it('disables Start rather than let a downgrade run', async () => {
    state.running = false;
    state.status = { ...defaultStatus(), phase: 'stopped' };
    state.drift = { deployed: '0.40.0', expected: '0.37.0', direction: 'downgrade' };
    await render();

    expect(button(/^Start$/).disabled).toBe(true);
  });
});

describe('waiting for another Console', () => {
  const bob = {
    name: 'bob@desk',
    hostAccount: 'bob',
    action: 'starting' as const,
    heldForSeconds: 40,
    expiresInSeconds: 80,
  };

  it('says who it is waiting for, and stops waiting when asked', async () => {
    state.transitioning = true;
    state.status = {
      ...defaultStatus(),
      phase: 'starting',
      message: 'Waiting for bob@desk (as bob) to finish starting the server…',
      waitingFor: bob,
    };
    await render();

    expect(document.body.textContent).toContain(
      'Waiting for bob@desk (as bob) to finish starting the server…'
    );
    await click(button(/^Stop waiting$/));

    expect(state.cancelWait).toHaveBeenCalledWith('vm-1');
  });

  it('offers no way to stop a start that is not waiting on anyone', async () => {
    state.transitioning = true;
    state.status = { ...defaultStatus(), phase: 'starting', message: 'Starting containers…' };
    await render();

    expect(document.body.textContent).toContain('Starting containers…');
    expect(() => button(/^Stop waiting$/)).toThrow();
  });
});
