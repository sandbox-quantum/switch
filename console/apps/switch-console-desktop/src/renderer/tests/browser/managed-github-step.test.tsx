/**
 * GitHub's own step, opened from the Connectors page: it offers to connect,
 * none of the setup wizard's ways onward, and a way back; and it says when an
 * organization's single sign-on hides the installation.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const switchServers = vi.hoisted(() => ({
  getGitHubConnection: vi.fn(),
  startGitHubConnection: vi.fn(),
  getGitHubFlow: vi.fn(),
  cancelGitHubConnection: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers },
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useModalContext: () => ({ setCloseGuard: () => {} }),
}));

import { ManagedGitHubStep } from '@renderer/features/switch-servers/managed-github-step';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  switchServers.getGitHubConnection.mockReset();
  switchServers.startGitHubConnection.mockReset();
  switchServers.getGitHubFlow.mockReset();
  switchServers.cancelGitHubConnection.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(onBack: () => void, onDone?: () => void): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <Dialog open>
        <DialogContent>
          <ManagedGitHubStep serverId="server" onBack={onBack} onDone={onDone} />
        </DialogContent>
      </Dialog>
    )
  );
}

function button(name: RegExp, within: ParentNode = document): HTMLButtonElement | undefined {
  return [...within.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

function dialog(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
}

it('offers to connect GitHub, and a way back', async () => {
  switchServers.getGitHubConnection.mockResolvedValue({
    status: 'not_connected',
    install_url: 'https://github.com/apps/example/installations/new',
  });
  const onBack = vi.fn();
  await render(onBack);

  await vi.waitFor(() => expect(button(/^connect github\s*$/i, dialog())).toBeDefined());
  expect(switchServers.getGitHubConnection).toHaveBeenCalledWith('server');
  expect(button(/set up later/i, dialog())).toBeUndefined();
  expect(button(/continue to agent/i, dialog())).toBeUndefined();

  await act(async () => button(/^back$/i, dialog())!.click());
  expect(onBack).toHaveBeenCalledOnce();
});

it("on a connector's page, a connected step offers Done and nothing else", async () => {
  switchServers.getGitHubConnection.mockResolvedValue({
    status: 'connected',
    login: 'example-user',
    install_url: 'https://github.com/apps/example/installations/new',
    installations: [{ id: 7, account: 'example-user', repositories: [{ id: 1, name: 'a/b' }] }],
  });
  const onDone = vi.fn();
  await render(() => {}, onDone);

  await vi.waitFor(() => expect(button(/^done$/i, dialog())).toBeDefined());
  expect(dialog().textContent).toContain('Connected as example-user');
  expect(dialog().textContent).toContain('a/b');
  expect(button(/^back$/i, dialog())).toBeUndefined();
  expect(button(/^disconnect$/i, dialog())).toBeUndefined();
  expect(dialog().textContent).not.toContain('Disconnecting removes credentials');

  await act(async () => button(/^done$/i, dialog())!.click());
  expect(onDone).toHaveBeenCalledOnce();
});

it("on a connector's page, Cancel stands in for Back before connecting", async () => {
  switchServers.getGitHubConnection.mockResolvedValue({
    status: 'not_connected',
    install_url: 'https://github.com/apps/example/installations/new',
  });
  const onBack = vi.fn();
  await render(onBack, () => {});

  await vi.waitFor(() => expect(button(/^connect github\s*$/i, dialog())).toBeDefined());
  expect(button(/^back$/i, dialog())).toBeUndefined();
  await act(async () => button(/^cancel$/i, dialog())!.click());
  expect(onBack).toHaveBeenCalledOnce();
});

it("says when an organization's single sign-on hides its installation", async () => {
  switchServers.getGitHubConnection.mockResolvedValue({
    status: 'connected',
    login: 'example-user',
    install_url: 'https://github.com/apps/example/installations/new',
    installations: [],
    sso_hidden_organizations: [21955855],
  });
  await render(() => {});

  await vi.waitFor(() =>
    expect(dialog().querySelector('[role="alert"]')?.textContent).toMatch(
      /single sign-on hides its installation/
    )
  );
});

const HINT =
  'If GitHub showed an error, cancel, and ask the person who set up the GitHub App for Switch to check its Callback URL.';

/** Starts a GitHub sign-in whose flow then answers `status` on every poll. */
async function startSignIn(status: 'pending' | 'checking'): Promise<void> {
  switchServers.getGitHubConnection.mockResolvedValue({
    status: 'not_connected',
    install_url: 'https://github.com/apps/example/installations/new',
  });
  switchServers.startGitHubConnection.mockResolvedValue('flow-1');
  switchServers.getGitHubFlow.mockResolvedValue({
    status,
    login: null,
    error: null,
    warning: null,
  });
  await render(() => {});
  await vi.waitFor(() => expect(button(/^connect github\s*$/i, dialog())).toBeDefined());
  await act(async () => button(/^connect github\s*$/i, dialog())!.click());
  await vi.waitFor(() => expect(dialog().textContent).toMatch(/Complete authorization/));
}

it('suggests what to check once the browser has been away a minute', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await startSignIn('pending');
    await act(async () => vi.advanceTimersByTimeAsync(59_000));
    expect(dialog().textContent).not.toContain('showed an error');
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(dialog().textContent).toContain(HINT);
  } finally {
    vi.useRealTimers();
  }
});

it('suggests nothing for a sign-in that came back before the minute', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await startSignIn('checking');
    await act(async () => vi.advanceTimersByTimeAsync(61_000));
    expect(dialog().textContent).toMatch(/Complete authorization/);
    expect(dialog().textContent).not.toContain('showed an error');
  } finally {
    vi.useRealTimers();
  }
});

it('keeps its minute when the page around it renders again', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await startSignIn('pending');
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    // A parent that passes a new onConnected on each render.
    await act(async () =>
      root!.render(
        <Dialog open>
          <DialogContent>
            <ManagedGitHubStep serverId="server" onBack={() => {}} onConnected={() => {}} />
          </DialogContent>
        </Dialog>
      )
    );
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(dialog().textContent).toContain(HINT);
  } finally {
    vi.useRealTimers();
  }
});

it('waits a new minute for a sign-in started again after Cancel', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await startSignIn('pending');
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(dialog().textContent).toContain(HINT);

    switchServers.cancelGitHubConnection.mockResolvedValue(undefined);
    await act(async () => button(/^cancel$/i, dialog())!.click());
    await vi.waitFor(() => expect(button(/^connect github\s*$/i, dialog())).toBeDefined());
    switchServers.startGitHubConnection.mockResolvedValue('flow-2');
    await act(async () => button(/^connect github\s*$/i, dialog())!.click());
    await act(async () => vi.advanceTimersByTimeAsync(59_000));
    expect(dialog().textContent).toMatch(/Complete authorization/);
    expect(dialog().textContent).not.toContain('showed an error');
  } finally {
    vi.useRealTimers();
  }
});
