/**
 * The SSH host-key dialog is the human check on a host Switch Console refused:
 * a new host is trusted only on "Trust and connect", a changed key is replaced
 * only once the person ticks that they checked it, a key that cannot be
 * trusted offers no way to trust it, and nothing is answered unasked.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { HostKeyProblem } from '@shared/core/ssh/host-keys';

const rpc = vi.hoisted(() => ({
  remoteHosts: {
    listHostKeyProblems: vi.fn(async (): Promise<HostKeyProblem[]> => []),
    trustHostKey: vi.fn(async () => {}),
    dismissHostKey: vi.fn(async () => {}),
  },
}));
const pushed = vi.hoisted(() => new Set<(problems: HostKeyProblem[]) => void>());
vi.mock('@renderer/lib/ipc', () => ({
  rpc,
  events: {
    on: (_channel: unknown, listener: (problems: HostKeyProblem[]) => void) => {
      pushed.add(listener);
      return () => pushed.delete(listener);
    },
  },
}));

import { HostKeyPromptGate } from '@renderer/features/remote-hosts/host-key-prompt';
import '@renderer/index.css';

const PRESENTED = 'SHA256:presentedFingerprintForTheseTestsOnly0000';
const ON_RECORD = 'SHA256:recordedFingerprintForTheseTestsOnly00000';

const UNKNOWN: HostKeyProblem = {
  sshHost: 'box',
  hostKeyName: 'box.example.com',
  kind: 'unknown',
  keyType: 'ssh-ed25519',
  fingerprint: PRESENTED,
  known: [],
  trustRefusal: null,
};

const CHANGED: HostKeyProblem = {
  ...UNKNOWN,
  kind: 'changed',
  known: [
    {
      source: '~/.ssh/known_hosts:3',
      keyType: 'ssh-ed25519',
      fingerprint: ON_RECORD,
    },
  ],
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  for (const fn of Object.values(rpc.remoteHosts)) fn.mockClear();
});

afterEach(async () => {
  await push([]);
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<HostKeyPromptGate />));
}

/** The main process pushing its list of refused keys, as it does on every change. */
async function push(problems: HostKeyProblem[]) {
  await act(async () => {
    for (const listener of pushed) listener(problems);
  });
}

function dialogText(): string {
  return document.querySelector('[role="dialog"]')?.textContent ?? '';
}

function button(text: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent === text
    ) ?? null
  );
}

function noAnswer() {
  expect(rpc.remoteHosts.trustHostKey).not.toHaveBeenCalled();
  expect(rpc.remoteHosts.dismissHostKey).not.toHaveBeenCalled();
}

describe('a host Switch Console has not connected to before', () => {
  it('asks about a host refused before the window opened, showing its fingerprint', async () => {
    rpc.remoteHosts.listHostKeyProblems.mockResolvedValueOnce([UNKNOWN]);
    await render();
    await expect.poll(dialogText).toContain('Trust this SSH host?');
    expect(dialogText()).toContain(PRESENTED);
    expect(dialogText()).toContain('ED25519');
    expect(dialogText()).toContain('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub');
    noAnswer();
  });

  it('trusts the presented key only on Trust and connect', async () => {
    await render();
    await push([UNKNOWN]);
    noAnswer();
    await act(async () => button('Trust and connect')!.click());
    expect(rpc.remoteHosts.trustHostKey).toHaveBeenCalledWith({
      sshHost: 'box',
      fingerprint: PRESENTED,
    });
    expect(rpc.remoteHosts.dismissHostKey).not.toHaveBeenCalled();
  });

  it('counts Don’t connect, and Escape, as not trusting it', async () => {
    await render();
    await push([UNKNOWN]);
    await act(async () => button('Don’t connect')!.click());
    expect(rpc.remoteHosts.dismissHostKey).toHaveBeenCalledWith({
      sshHost: 'box',
      fingerprint: PRESENTED,
    });

    rpc.remoteHosts.dismissHostKey.mockClear();
    await userEvent.keyboard('{Escape}');
    await expect.poll(() => rpc.remoteHosts.dismissHostKey.mock.calls.length).toBe(1);
    expect(rpc.remoteHosts.trustHostKey).not.toHaveBeenCalled();
  });
});

describe('a host whose key changed', () => {
  it('shows both fingerprints and replaces the key only once the person ticks that they checked it', async () => {
    await render();
    await push([CHANGED]);
    expect(dialogText()).toContain('SSH host key changed');
    expect(dialogText()).toContain(`Presented now · ED25519${PRESENTED}`);
    expect(dialogText()).toContain(`On record · ED25519${ON_RECORD}`);

    const replace = button('Replace the key and connect')!;
    expect(replace.disabled).toBe(true);
    await act(async () => replace.click());
    noAnswer();

    const checked = document.querySelector<HTMLElement>('[role="dialog"] [role="checkbox"]')!;
    await act(async () => checked.click());
    expect(button('Replace the key and connect')!.disabled).toBe(false);
    await act(async () => button('Replace the key and connect')!.click());
    expect(rpc.remoteHosts.trustHostKey).toHaveBeenCalledWith({
      sshHost: 'box',
      fingerprint: PRESENTED,
    });
  });
});

describe('a key Switch Console cannot trust', () => {
  it('offers no way to trust a revoked key, only to close', async () => {
    await render();
    await push([
      {
        ...CHANGED,
        kind: 'revoked',
        trustRefusal: 'This key is revoked in ~/.ssh/known_hosts.',
      },
    ]);
    expect(dialogText()).toContain('SSH host key revoked');
    expect(dialogText()).toContain('This key is revoked in ~/.ssh/known_hosts.');
    expect(button('Trust and connect')).toBeNull();
    expect(button('Replace the key and connect')).toBeNull();
    expect(document.querySelector('[role="dialog"] [role="checkbox"]')).toBeNull();
    noAnswer();
    await act(async () => button('Close')!.click());
    expect(rpc.remoteHosts.dismissHostKey).toHaveBeenCalledTimes(1);
    expect(rpc.remoteHosts.trustHostKey).not.toHaveBeenCalled();
  });

  it('offers no way to trust a new host its SSH config says must already be known', async () => {
    await render();
    await push([{ ...UNKNOWN, trustRefusal: 'Its SSH config sets StrictHostKeyChecking yes.' }]);
    expect(dialogText()).toContain('Unknown SSH host');
    expect(button('Trust and connect')).toBeNull();
    noAnswer();
  });
});

describe('a refusal from a background connection', () => {
  it('is put to the person and left for them, however long it waits', async () => {
    await render();
    await push([UNKNOWN, CHANGED]);
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 50)));
    // One at a time: the first is asked, the second waits.
    expect(dialogText()).toContain('Trust this SSH host?');
    noAnswer();
    // Answered elsewhere (another window), it goes without an answer from here.
    await push([]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    noAnswer();
  });
});
