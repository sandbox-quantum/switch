/**
 * Deleting your account: nothing happens until the account's own email is
 * typed, a refusal is shown in the server's words, and once it is gone the
 * dialog offers to start over from the first-run pages.
 */
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

const deleteAccount = vi.hoisted(() => vi.fn());
const rehearse = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { deleteAccount },
}));
vi.mock('@renderer/features/onboarding/onboarding-store', () => ({
  onboardingStore: { rehearse },
}));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation: { navigate } },
}));

import { DeleteAccountModal } from '@renderer/features/switch-servers/delete-account-modal';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
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
  const onClose = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <Dialog open>
        <DialogContent>
          <DeleteAccountModal
            serverId="srv-1"
            serverName="Switch Cloud"
            email="ada@example.test"
            onSuccess={() => {}}
            onClose={onClose}
          />
        </DialogContent>
      </Dialog>
    )
  );
  return onClose;
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (each) => each.textContent?.trim() === name
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

async function type(value: string) {
  const input = document.getElementById('delete-account-email') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('DeleteAccountModal', () => {
  it('stays shut until the account email is typed', async () => {
    await render();
    expect(button('Delete my account').disabled).toBe(true);
    await type('someone@example.test');
    expect(button('Delete my account').disabled).toBe(true);
    await type(' Ada@Example.test ');
    expect(button('Delete my account').disabled).toBe(false);
  });

  it("shows the server's reason when it refuses", async () => {
    deleteAccount.mockRejectedValueOnce(
      new Error("You're the only owner of Acme, which has other members.")
    );
    await render();
    await type('ada@example.test');
    await act(async () => button('Delete my account').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('only owner of Acme');
  });

  it('offers to start over once the account is gone', async () => {
    deleteAccount.mockResolvedValueOnce(undefined);
    const onClose = await render();
    await type('ada@example.test');
    await act(async () => button('Delete my account').click());
    expect(deleteAccount).toHaveBeenCalledWith('srv-1', 'ada@example.test');
    expect(document.body.textContent).toContain('Your account is deleted');
    await act(async () => button('Start over').click());
    expect(onClose).toHaveBeenCalled();
    expect(rehearse).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('home');
  });
});
