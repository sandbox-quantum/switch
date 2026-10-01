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

const register = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@renderer/features/switch-servers/remote-server-store', () => ({
  remoteServerStore: { registerFor: () => register.current },
}));

import { useSharedActionConfirm } from '@renderer/features/switch-servers/shared-action-confirm';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function Harness({ sshHost, run }: { sshHost: string | null; run: () => void }) {
  const confirm = useSharedActionConfirm(sshHost);
  return (
    <>
      <button type="button" data-testid="stop" onClick={() => confirm.request('stop', run)}>
        Stop
      </button>
      {confirm.dialog}
    </>
  );
}

async function clickStop(sshHost: string | null) {
  const run = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness sshHost={sshHost} run={run} />));
  await act(async () =>
    (container!.querySelector('[data-testid="stop"]') as HTMLButtonElement).click()
  );
  return run;
}

function dialogText(): string {
  return document.querySelector('[role="dialog"]')?.textContent ?? '';
}

describe('asking before a shared stop or restart', () => {
  it('stops at once when nobody else has used the server lately', async () => {
    register.current = { self: 'me', consoles: [], activity: [] };

    const run = await clickStop('vm-1');

    expect(run).toHaveBeenCalledOnce();
    expect(dialogText()).toBe('');
  });

  it('asks, naming them, when others have', async () => {
    register.current = {
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

    const run = await clickStop('vm-1');

    expect(run).not.toHaveBeenCalled();
    expect(dialogText()).toMatch(/Stop the server on vm-1 for everyone\?/);
    expect(dialogText()).toMatch(/bob@desk \(as bob\)/);
  });

  it('asks when who uses the server has not been read', async () => {
    register.current = null;

    const run = await clickStop('vm-1');

    expect(run).not.toHaveBeenCalled();
    expect(dialogText()).toMatch(/could not check who else uses it/);
  });

  it('never asks for a server nobody else shares', async () => {
    register.current = null;

    const run = await clickStop(null);

    expect(run).toHaveBeenCalledOnce();
  });
});

describe('changing one’s mind', () => {
  it('does nothing when the question is cancelled', async () => {
    register.current = null;

    const run = await clickStop('vm-1');
    const cancel = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Cancel'
    )!;
    await act(async () => cancel.click());

    expect(run).not.toHaveBeenCalled();
    // It closes as a stop: the words do not change on the way out.
    expect(dialogText()).not.toMatch(/Restart/);
    await vi.waitFor(() => expect(dialogText()).toBe(''));
  });

  it('runs the action once when it is confirmed', async () => {
    register.current = null;

    const run = await clickStop('vm-1');
    const confirm = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Stop for everyone'
    )!;
    await act(async () => confirm.click());

    expect(run).toHaveBeenCalledOnce();
    expect(dialogText()).not.toMatch(/Restart/);
    await vi.waitFor(() => expect(dialogText()).toBe(''));
  });
});
