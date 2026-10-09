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

const servers = vi.hoisted(() => ({
  current: [] as unknown[],
  deleteServer: vi.fn(),
  errorText: null as string | null,
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    get servers() {
      return servers.current;
    },
    deleteServer: (...args: unknown[]) => servers.deleteServer(...args),
    get errorText() {
      return servers.errorText;
    },
  },
}));

const remote = vi.hoisted(() => ({
  register: null as unknown,
  disconnect: vi.fn(),
  deleteForEveryone: vi.fn(),
  errorText: null as string | null,
  loadRegister: vi.fn(),
}));
vi.mock('@renderer/features/switch-servers/remote-server-store', () => ({
  remoteServerStore: {
    registerFor: () => remote.register,
    loadRegister: (...args: unknown[]) => remote.loadRegister(...args),
    disconnect: (...args: unknown[]) => remote.disconnect(...args),
    deleteForEveryone: (...args: unknown[]) => remote.deleteForEveryone(...args),
    get errorText() {
      return remote.errorText;
    },
  },
}));

vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: {
    load: () => Promise.resolve(),
    byLocation: new Map(),
  },
}));

import { DeleteServerModal } from '@renderer/features/switch-servers/DeleteServerModal';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  servers.current = [];
  servers.deleteServer.mockReset().mockResolvedValue(true);
  servers.errorText = null;
  remote.register = null;
  remote.disconnect.mockReset().mockResolvedValue(true);
  remote.deleteForEveryone.mockReset().mockResolvedValue(true);
  remote.errorText = null;
  remote.loadRegister.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

const REMOTE_SERVER = {
  id: 'srv-1',
  name: 'Team Server',
  url: 'https://api.example',
  dashboardUrl: 'https://gateway.example',
  managed: true,
  managementKind: 'remote' as const,
  sshHost: 'vm-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const EXTERNAL_SERVER = {
  id: 'srv-2',
  name: 'External Server',
  url: 'https://api.example',
  dashboardUrl: 'https://gateway.example',
  managed: false,
  managementKind: null,
  sshHost: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

async function render(serverId: string) {
  const onSuccess = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <Dialog open>
        <DialogContent>
          <DeleteServerModal serverId={serverId} onSuccess={onSuccess} onClose={() => {}} />
        </DialogContent>
      </Dialog>
    )
  );
  return onSuccess;
}

function radio(label: RegExp): HTMLButtonElement {
  const button = [...document.querySelectorAll('button[role="radio"]')].find((b) =>
    label.test(b.textContent ?? '')
  );
  if (!button) throw new Error(`no radio option matching ${label}`);
  return button as HTMLButtonElement;
}

function confirmButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button:not([role="radio"])')].find((b) =>
    /^(Disconnect|Delete)/.test(b.textContent ?? '')
  );
  if (!button) throw new Error('no confirm button');
  return button as HTMLButtonElement;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('removing a remote managed server', () => {
  it('defaults to disconnecting this Console rather than destroying the stack', async () => {
    servers.current = [REMOTE_SERVER];
    const onSuccess = await render(REMOTE_SERVER.id);

    expect(radio(/Disconnect this Console/).getAttribute('aria-checked')).toBe('true');
    expect(radio(/Delete it for everyone/).getAttribute('aria-checked')).toBe('false');
    expect(confirmButton().textContent).toContain('Disconnect');

    await click(confirmButton());

    expect(remote.disconnect).toHaveBeenCalledWith('vm-1', REMOTE_SERVER.id);
    expect(remote.deleteForEveryone).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalled();
  });

  it('requires typing the server name before it will delete it for everyone', async () => {
    servers.current = [REMOTE_SERVER];
    await render(REMOTE_SERVER.id);

    await click(radio(/Delete it for everyone/));
    expect(confirmButton().disabled).toBe(true);

    const input = document.querySelector('input') as HTMLInputElement;
    await type(input, 'wrong name');
    expect(confirmButton().disabled).toBe(true);

    await type(input, REMOTE_SERVER.name);
    expect(confirmButton().disabled).toBe(false);

    await click(confirmButton());

    expect(remote.deleteForEveryone).toHaveBeenCalledWith('vm-1', REMOTE_SERVER.id);
    expect(remote.disconnect).not.toHaveBeenCalled();
    expect(servers.deleteServer).not.toHaveBeenCalled();
  });

  it('shows who else uses the server once destroying it is chosen', async () => {
    servers.current = [REMOTE_SERVER];
    remote.register = {
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
    await render(REMOTE_SERVER.id);

    expect(document.body.textContent).not.toContain('Also used recently by');

    await click(radio(/Delete it for everyone/));

    expect(document.body.textContent).toContain('Also used recently by');
    expect(document.body.textContent).toContain('bob@desk (as bob)');
  });

  it('says who else uses it could not be checked when the register is null', async () => {
    servers.current = [REMOTE_SERVER];
    remote.register = null;
    await render(REMOTE_SERVER.id);

    await click(radio(/Delete it for everyone/));

    expect(document.body.textContent).toContain('Switch Console could not check who else uses it.');
  });

  it('shows the store error when disconnecting fails', async () => {
    servers.current = [REMOTE_SERVER];
    remote.disconnect.mockResolvedValue(false);
    remote.errorText = 'SSH connection to vm-1 timed out.';
    await render(REMOTE_SERVER.id);

    await click(confirmButton());

    expect(document.body.textContent).toContain('SSH connection to vm-1 timed out.');
  });
});

describe('removing an external server', () => {
  it('has no destroy-for-everyone choice and calls switchServersStore.deleteServer', async () => {
    servers.current = [EXTERNAL_SERVER];
    const onSuccess = await render(EXTERNAL_SERVER.id);

    expect(document.querySelectorAll('[role="radiogroup"]')).toHaveLength(0);

    await click(confirmButton());

    expect(servers.deleteServer).toHaveBeenCalledWith(EXTERNAL_SERVER.id);
    expect(remote.disconnect).not.toHaveBeenCalled();
    expect(remote.deleteForEveryone).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalled();
  });
});

describe('the paths the rest leave', () => {
  it('says a server that has gone is no longer there', async () => {
    servers.current = [];
    await render('srv-gone');

    expect(document.body.textContent).toContain('This server is no longer available.');
  });

  it('says it could not remove the server when the store gives no reason', async () => {
    servers.current = [REMOTE_SERVER];
    remote.disconnect.mockResolvedValue(false);
    remote.errorText = null;
    await render(REMOTE_SERVER.id);

    await click(confirmButton());

    expect(document.body.textContent).toContain('Could not remove the server.');
  });

  it('offers to delete a server on this computer outright, which nobody else uses', async () => {
    servers.current = [{ ...REMOTE_SERVER, managementKind: 'local', sshHost: null }];
    await render(REMOTE_SERVER.id);

    expect(document.body.textContent).toContain('Delete “Team Server”?');
    expect(document.querySelectorAll('[role="radiogroup"]')).toHaveLength(0);
    expect(confirmButton().textContent).toContain('Delete server');
  });

  it('shows why a server someone else runs could not be let go of', async () => {
    servers.current = [EXTERNAL_SERVER];
    servers.deleteServer.mockResolvedValue(false);
    servers.errorText = 'The server record is locked by another window.';
    await render(EXTERNAL_SERVER.id);

    await click(confirmButton());

    expect(document.body.textContent).toContain('The server record is locked by another window.');
  });

  it('asks whether to disconnect from a server someone else runs', async () => {
    servers.current = [EXTERNAL_SERVER];
    await render(EXTERNAL_SERVER.id);

    expect(document.body.textContent).toContain('Disconnect from “External Server”?');
  });
});
