/**
 * Changing your password from Settings › Your account: success is said on the
 * page, where the person just acted, and only until they leave it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const changeMyPassword = vi.hoisted(() => vi.fn());
const refreshStatus = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers: { changeMyPassword } },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { refreshStatus },
}));

import { ChangePassword } from '@renderer/features/settings/pages/account-page';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <ChangePassword serverId="srv-1" />
      </QueryClientProvider>
    )
  );
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (each) => each.textContent?.trim() === name
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

async function type(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function changePassword() {
  await act(async () => button('Change password').click());
  await type('account-current-password', 'old-password');
  await type('account-new-password', 'new-password-1');
  await type('account-confirm-password', 'new-password-1');
  const submit = document.querySelector('button[type="submit"]') as HTMLButtonElement;
  await act(async () => submit.click());
}

describe('ChangePassword', () => {
  it('says the password changed on the page once the server accepts it', async () => {
    changeMyPassword.mockResolvedValueOnce(undefined);
    await render();
    await changePassword();
    expect(changeMyPassword).toHaveBeenCalledWith({
      serverId: 'srv-1',
      currentPassword: 'old-password',
      newPassword: 'new-password-1',
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Password changed successfully'
    );
    // Whatever was refused while the old session was ending can have shown the
    // server as signed out; it is read again with the new session in place.
    expect(refreshStatus).toHaveBeenCalledWith('srv-1');
  });

  it('does not carry the message over once the page is left and opened again', async () => {
    changeMyPassword.mockResolvedValueOnce(undefined);
    await render();
    await changePassword();
    expect(document.body.textContent).toContain('Password changed successfully');

    await act(async () => root!.unmount());
    container!.remove();
    await render();
    expect(document.body.textContent).not.toContain('Password changed successfully');
  });

  it('says nothing of success when the server refuses', async () => {
    changeMyPassword.mockRejectedValueOnce(new Error('Current password is incorrect'));
    await render();
    await changePassword();
    expect(document.body.textContent).not.toContain('Password changed successfully');
    expect(refreshStatus).not.toHaveBeenCalled();
  });
});
