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
  register: null as unknown,
  registerError: null as string | null,
}));

vi.mock('@renderer/features/switch-servers/remote-server-store', () => ({
  remoteServerStore: {
    registerFor: () => state.register,
    registerErrorFor: () => state.registerError,
  },
}));

/**
 * Who uses a shared remote server (CHOO-2893): everyone signs in as the
 * server's one admin account, so this reads the record each Console leaves on
 * the host instead of the server's own user list.
 */
import { SharedConsolesSection } from '@renderer/features/switch-servers/shared-consoles-section';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const SELF_CONSOLE = {
  consoleId: 'me',
  name: 'me@laptop',
  hostAccount: 'deploy',
  appVersion: '0.37.0',
  lastSeenAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
};

const OTHER_CONSOLE = {
  consoleId: 'bob',
  name: 'bob@desk',
  hostAccount: 'bob',
  appVersion: '0.36.0',
  lastSeenAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
};

beforeEach(() => {
  state.register = null;
  state.registerError = null;
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
  await act(async () => root!.render(<SharedConsolesSection sshHost="vm-1" />));
}

describe('listing who uses a shared server', () => {
  it('renders nothing before the register has been read', async () => {
    state.register = null;
    state.registerError = null;
    await render();

    expect(container?.textContent).toBe('');
  });

  it('renders nothing for a server nobody has recorded anything on', async () => {
    state.register = { self: 'me', consoles: [], activity: [] };
    await render();

    expect(container?.textContent).toBe('');
  });

  it('lists each Console, marking this Console among them', async () => {
    state.register = { self: 'me', consoles: [SELF_CONSOLE, OTHER_CONSOLE], activity: [] };
    await render();

    const items = [...document.querySelectorAll('li')];
    const selfItem = items.find((li) => li.textContent?.includes('me@laptop'));
    const otherItem = items.find((li) => li.textContent?.includes('bob@desk'));

    expect(selfItem?.textContent).toContain('me@laptop (as deploy)');
    expect(selfItem?.textContent).toContain('this Console');
    expect(otherItem?.textContent).toContain('bob@desk (as bob)');
    expect(otherItem?.textContent).not.toContain('this Console');
  });

  it('shows recent activity lines', async () => {
    state.register = {
      self: 'me',
      consoles: [SELF_CONSOLE],
      activity: [
        {
          at: new Date().toISOString(),
          action: 'started',
          consoleId: 'me',
          name: 'me@laptop',
          hostAccount: 'deploy',
        },
        {
          at: new Date().toISOString(),
          action: 'stopped',
          consoleId: 'bob',
          name: 'bob@desk',
          hostAccount: 'bob',
        },
      ],
    };
    await render();

    expect(document.body.textContent).toContain('This Console started it');
    expect(document.body.textContent).toContain('bob@desk stopped it');
  });

  it('shows the error reading the register, when there is one', async () => {
    state.register = null;
    state.registerError = 'Could not read who uses this server.';
    await render();

    expect(document.body.textContent).toContain('Could not read who uses this server.');
  });
});
