/**
 * Confirming disconnection of a messaging app (CHOO-2137).
 *
 * The warning shown depends on whether the bridge is backed by a live
 * install — asked as the dialog opens — since that decides whether its rooms
 * are deleted or kept as internal-only. Until the answer is in, or if asking
 * fails, the strongest warning stays up rather than understating what is
 * about to happen.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeInstallState = vi.hoisted(() => vi.fn());
const deleteBridge = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { workspaces: { bridgeInstallState, deleteBridge } },
  events: { on: () => () => {}, emit: () => {} },
}));

import { DisconnectMessagingAppModal } from '@renderer/features/switch-servers/DisconnectMessagingAppModal';
import { Dialog } from '@renderer/lib/ui/dialog';

const onSuccess = vi.fn();
const onClose = vi.fn();

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  bridgeInstallState.mockReset();
  deleteBridge.mockReset();
  onSuccess.mockReset();
  onClose.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(props: { bridgeType?: string } = {}): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <Dialog open onOpenChange={() => {}}>
        <DisconnectMessagingAppModal
          workspaceId="ws-1"
          bridgeId="b-1"
          bridgeDisplayName="Acme"
          bridgeType={props.bridgeType ?? 'slack'}
          onSuccess={onSuccess}
          onClose={onClose}
        />
      </Dialog>
    )
  );
  await settle();
  return document.body;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve());
}

function confirmButton(el: HTMLElement): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes('Disconnect app')
  );
  expect(found, 'no disconnect button').toBeDefined();
  return found!;
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

async function confirmName(el: HTMLElement, name: string): Promise<void> {
  const input = el.querySelector('input') as HTMLInputElement;
  await type(input, name);
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

describe('the install-state copy', () => {
  it('warns that a bridge with no install takes its rooms with it', async () => {
    bridgeInstallState.mockResolvedValue('not-installed');
    const el = await render();

    expect(el.textContent).toContain('deletes every Switch room');
  });

  it('says an installed bridge keeps its rooms as internal-only', async () => {
    bridgeInstallState.mockResolvedValue('installed');
    const el = await render({ bridgeType: 'slack' });

    expect(el.textContent).toContain('not deleted');
    expect(el.textContent).not.toContain('deletes every Switch room');
  });

  it('says the distributed Teams app also leaves every team it was added to', async () => {
    bridgeInstallState.mockResolvedValue('installed');
    const el = await render({ bridgeType: 'teams' });

    expect(el.textContent).toContain('leaves every team');
    expect(el.textContent).toContain('Microsoft Entra admin center');
  });

  it('keeps the strongest warning up when the install state could not be read', async () => {
    bridgeInstallState.mockResolvedValue('unknown');
    const el = await render();

    expect(el.textContent).toContain('deletes every Switch room');
  });

  it('falls back to "unknown" rather than leaving the state unset when the lookup throws', async () => {
    bridgeInstallState.mockRejectedValue(new Error('boom'));
    const el = await render();

    // Thrown or resolved 'unknown' read the same: the strongest warning.
    expect(el.textContent).toContain('deletes every Switch room');
  });
});

describe('confirming and disconnecting', () => {
  beforeEach(() => {
    bridgeInstallState.mockResolvedValue('not-installed');
  });

  it('keeps Disconnect disabled until the exact name is typed', async () => {
    const el = await render();

    expect(confirmButton(el).disabled).toBe(true);

    await confirmName(el, 'not quite Acme');
    expect(confirmButton(el).disabled).toBe(true);

    await confirmName(el, 'Acme');
    expect(confirmButton(el).disabled).toBe(false);
  });

  it('calls the RPC with the workspace and bridge, and reports success', async () => {
    deleteBridge.mockResolvedValue({ kind: 'deleted' });
    const el = await render();
    await confirmName(el, 'Acme');

    await click(confirmButton(el));
    await settle();

    expect(deleteBridge).toHaveBeenCalledWith({ workspaceId: 'ws-1', bridgeId: 'b-1' });
    expect(onSuccess).toHaveBeenCalled();
  });

  it('prompts a sign-in for an expired session rather than claiming success', async () => {
    deleteBridge.mockResolvedValue({ kind: 'unauthenticated' });
    const el = await render();
    await confirmName(el, 'Acme');

    await click(confirmButton(el));
    await settle();

    expect(el.textContent).toContain('Your session for this server expired');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('names the admin requirement when forbidden', async () => {
    deleteBridge.mockResolvedValue({ kind: 'forbidden' });
    const el = await render();
    await confirmName(el, 'Acme');

    await click(confirmButton(el));
    await settle();

    expect(el.textContent).toContain('requires an owner or admin of this workspace');
  });

  it('says the app is already gone rather than retrying a disconnect', async () => {
    deleteBridge.mockResolvedValue({ kind: 'not-found' });
    const el = await render();
    await confirmName(el, 'Acme');

    await click(confirmButton(el));
    await settle();

    expect(el.textContent).toContain('no longer connected to this server');
  });

  it('shows a generic failure’s own message', async () => {
    deleteBridge.mockResolvedValue({ kind: 'error', message: 'adapter shutdown failed' });
    const el = await render();
    await confirmName(el, 'Acme');

    await click(confirmButton(el));
    await settle();

    expect(el.textContent).toContain('adapter shutdown failed');
  });

  it('shows a fallback message when the call throws rather than resolves', async () => {
    deleteBridge.mockRejectedValue(new Error('rpc exploded'));
    const el = await render();
    await confirmName(el, 'Acme');

    await click(confirmButton(el));
    await settle();

    expect(el.textContent).toContain('Could not disconnect the messaging app.');
  });
});
