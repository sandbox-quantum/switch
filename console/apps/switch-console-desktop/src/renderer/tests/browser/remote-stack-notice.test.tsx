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

import { RemoteStackNotice } from '@renderer/features/switch-servers/AddServerModal';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(props: Parameters<typeof RemoteStackNotice>[0]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<RemoteStackNotice {...props} />));
}

describe('connecting to a stack already running on the host', () => {
  it('says connecting will not restart it when this Console already matches its version', async () => {
    await render({
      sshHost: 'vm-1',
      action: { kind: 'connect', deployedVersion: '0.37.0', shared: true, updatesTo: null },
      affected: null,
      onCheckAgain: vi.fn(),
    });

    expect(document.body.textContent).toContain(
      'Connecting adds it to this Console without restarting it, so anyone already using it carries on undisturbed.'
    );
  });

  it('says connecting updates it for everyone when this Console needs a newer switch-core, and names who it reaches', async () => {
    await render({
      sshHost: 'vm-1',
      action: { kind: 'connect', deployedVersion: '0.36.0', shared: true, updatesTo: '0.28.0' },
      affected: 'Also used recently by bob@desk (as bob), 2 hours ago.',
      onCheckAgain: vi.fn(),
    });

    expect(document.body.textContent).toContain('This Console needs switch-core 0.28.0');
    expect(document.body.textContent).toContain('updates it');
    expect(document.body.textContent).toContain('for everyone who uses it');
    expect(document.body.textContent).toContain(
      'Also used recently by bob@desk (as bob), 2 hours ago.'
    );
  });
});

describe('a host with nothing safe to do from this account', () => {
  it('shows the title and detail, and calls onCheckAgain when asked to check again', async () => {
    const onCheckAgain = vi.fn();
    await render({
      sshHost: 'vm-1',
      action: {
        kind: 'blocked',
        title: 'The server on vm-1 belongs to another account',
        detail: 'Its settings were never shared with this account.',
      },
      affected: null,
      onCheckAgain,
    });

    expect(document.body.textContent).toContain('The server on vm-1 belongs to another account');
    expect(document.body.textContent).toContain(
      'Its settings were never shared with this account.'
    );

    const checkAgain = [...document.querySelectorAll('button')].find((b) =>
      /Check again/.test(b.textContent ?? '')
    );
    expect(checkAgain).toBeDefined();
    await act(async () => checkAgain!.click());

    expect(onCheckAgain).toHaveBeenCalledOnce();
  });
});

describe('starting a stack already set up but stopped', () => {
  it('says starting keeps its data', async () => {
    await render({
      sshHost: 'vm-1',
      action: { kind: 'start', existing: true },
      affected: null,
      onCheckAgain: vi.fn(),
    });

    expect(document.body.textContent).toContain('A Switch server is set up on vm-1, but stopped');
    expect(document.body.textContent).toContain('Starting it keeps its rooms, agents and data');
  });
});

describe('the rest of what the step can say', () => {
  it('says it is looking while the host has not answered yet', async () => {
    await render({
      sshHost: 'vm-1',
      action: { kind: 'checking' },
      affected: null,
      onCheckAgain: vi.fn(),
    });

    expect(document.body.textContent).toContain('Looking for a Switch server on vm-1…');
  });

  it('shares a server set up before sharing existed when connecting, and names no version it cannot read', async () => {
    await render({
      sshHost: 'vm-1',
      action: { kind: 'connect', deployedVersion: null, shared: false, updatesTo: null },
      affected: null,
      onCheckAgain: vi.fn(),
    });

    expect(document.body.textContent).toContain('A Switch server is already running on vm-1');
    expect(document.body.textContent).not.toContain('(switch-core');
    expect(document.body.textContent).toContain('connecting shares it');
  });

  it('says nothing for an empty host, or one whose Docker notice already says why', async () => {
    await render({
      sshHost: 'vm-1',
      action: { kind: 'start', existing: false },
      affected: null,
      onCheckAgain: vi.fn(),
    });
    expect(container!.textContent).toBe('');

    await act(async () =>
      root!.render(
        <RemoteStackNotice
          sshHost="vm-1"
          action={{ kind: 'docker' }}
          affected={null}
          onCheckAgain={vi.fn()}
        />
      )
    );
    expect(container!.textContent).toBe('');
  });
});
