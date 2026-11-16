/**
 * Where a login given to a machine goes: the fingerprint of the key it is
 * sealed to is shown before it is given, a key Switch changed since the first
 * login is shown beside the old one and refused until the user trusts it, and
 * a key Console refuses outright gives no way to send the login.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const giveMachineLogin = vi.hoisted(() => vi.fn());
const machineLoginOutcome = vi.hoisted(() => vi.fn());
const machineSealingKey = vi.hoisted(() => vi.fn());
const trustMachineSealingKey = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    managedAgents: {
      giveMachineLogin,
      machineLoginOutcome,
      machineSealingKey,
      trustMachineSealingKey,
    },
  },
  events: { on: () => () => {}, emit: () => {} },
}));

import { GiveMachineLogin } from '@renderer/features/locations/components/add-agent-modal/give-machine-login';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import '@renderer/index.css';

const PINNED = '6668 7aad f862 bd77 6c8f c18b 8e9f 8e20';
const SWAPPED = 'dead beef dead beef dead beef dead beef';

const MACHINE: OwnedMachine = {
  id: 'controller-1',
  name: 'build-box',
  kind: 'daemon',
  state: 'online',
  providers: [],
  acceptsLogins: true,
  cloud: false,
  workspacesDir: null,
  os: null,
  local: null,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  giveMachineLogin.mockReset().mockResolvedValue({ operationId: 'op-1' });
  machineLoginOutcome.mockReset().mockResolvedValue({ state: 'succeeded' });
  machineSealingKey.mockReset();
  trustMachineSealingKey.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <GiveMachineLogin
          serverId="server-1"
          machine={MACHINE}
          provider="claude"
          onClose={() => {}}
        />
      </QueryClientProvider>
    )
  );
  await settle();
  return container;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve());
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text
  );
  expect(found, `no ${text} button`).toBeDefined();
  return found!;
}

async function typeToken(el: HTMLElement, value: string): Promise<void> {
  const field = el.querySelector<HTMLInputElement>('input[aria-label="Setup token"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the key a machine’s login is sealed to', () => {
  it('shows the fingerprint a first login pins, and gives the login with it', async () => {
    machineSealingKey.mockResolvedValue({ state: 'first-use', fingerprint: PINNED });
    const el = await render();

    expect(el.textContent).toContain(PINNED);
    expect(el.textContent).toContain('Console remembers it and refuses another');
    await typeToken(el, 'sk-ant-oat-placeholder');
    await act(async () => button(el, 'Give login').click());
    await settle();

    expect(giveMachineLogin).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 'controller-1', fingerprint: PINNED })
    );
  });

  it('shows a changed key beside the old one, refuses the login, and trusts it only when asked', async () => {
    machineSealingKey.mockResolvedValue({
      state: 'changed',
      fingerprint: SWAPPED,
      previousFingerprint: PINNED,
    });
    const el = await render();

    expect(el.textContent).toContain('build-box’s key changed');
    expect(el.textContent).toContain(PINNED);
    expect(el.textContent).toContain(SWAPPED);
    await typeToken(el, 'sk-ant-oat-placeholder');
    expect(button(el, 'Give login').disabled).toBe(true);

    machineSealingKey.mockResolvedValue({
      state: 'verified',
      fingerprint: SWAPPED,
      source: 'pinned',
    });
    await act(async () => button(el, 'Trust the new key').click());
    await settle();

    expect(trustMachineSealingKey).toHaveBeenCalledWith({
      serverId: 'server-1',
      machineId: 'controller-1',
      fingerprint: SWAPPED,
    });
    expect(el.textContent).not.toContain('key changed');
    expect(button(el, 'Give login').disabled).toBe(false);
  });

  it('gives no way to send a login to a key Console refuses', async () => {
    machineSealingKey.mockResolvedValue({
      state: 'refused',
      reason: 'build-box is this computer, whose controller keeps no key for given logins.',
    });
    const el = await render();
    await typeToken(el, 'sk-ant-oat-placeholder');

    expect(el.textContent).toContain('whose controller keeps no key');
    expect(button(el, 'Give login').disabled).toBe(true);
    expect(giveMachineLogin).not.toHaveBeenCalled();
  });
});
