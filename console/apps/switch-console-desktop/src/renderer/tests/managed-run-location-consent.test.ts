// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewAgentMachine } from '@shared/core/agent-migration/agent-migration';

const rpc = vi.hoisted(() => ({
  embeddedController: { enable: vi.fn() },
  hostControllers: { enable: vi.fn() },
}));
vi.mock('@renderer/lib/ipc', () => ({ rpc, events: { on: () => () => {} } }));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    serverById: (id: string) =>
      id === 'server-1' ? { name: 'Acme', url: 'https://switch.example.com' } : null,
  },
}));
vi.mock('@renderer/lib/components/provider-connection-status', () => ({
  invalidateHostProviderReadiness: vi.fn(),
}));

const { ManagedRunLocationNotice } =
  await import('@renderer/features/locations/components/add-agent-modal/managed-run-location-notice');
const { machineConsent, serverForConsent } =
  await import('@renderer/features/machines/turn-on-machine');
const { ComputerNote } = await import('@renderer/features/switch-buddy/provider-cards');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BLOCKED: NewAgentMachine = {
  management: true,
  target: null,
  blocker: 'Turn it on first.',
  canEnable: true,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  rpc.embeddedController.enable.mockReset().mockResolvedValue(undefined);
  rpc.hostControllers.enable.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(sshHost: string | null, onEnabled = vi.fn()) {
  const client = new QueryClient();
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ManagedRunLocationNotice, {
          machine: BLOCKED,
          label: sshHost ?? 'This computer',
          sshHost,
          serverId: 'server-1',
          workspaceId: 'workspace-1',
          onEnabled,
        })
      )
    )
  );
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!found) throw new Error(`No button "${text}" in: ${container.textContent}`);
  return found;
}

describe('turning a machine on from the new agent form', () => {
  it('does nothing on its own when the form opens, as it does from a link', async () => {
    await render(null);
    await render(null);
    expect(rpc.embeddedController.enable).not.toHaveBeenCalled();
    expect(rpc.hostControllers.enable).not.toHaveBeenCalled();
  });

  it('asks first, naming the server, and turns this computer on only once confirmed', async () => {
    const onEnabled = vi.fn();
    await render(null, onEnabled);
    await act(async () => button('Run managed agents on this computer').click());
    expect(rpc.embeddedController.enable).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      'Acme (switch.example.com) can then start, change and stop agents on this computer'
    );
    await act(async () => button('Cancel').click());
    expect(rpc.embeddedController.enable).not.toHaveBeenCalled();
    await act(async () => button('Run managed agents on this computer').click());
    await act(async () => button('Turn on').click());
    expect(rpc.embeddedController.enable).toHaveBeenCalledWith({
      serverId: 'server-1',
      workspaceId: 'workspace-1',
    });
    expect(onEnabled).toHaveBeenCalled();
  });

  it('makes an SSH host a machine only once confirmed', async () => {
    await render('box');
    expect(rpc.hostControllers.enable).not.toHaveBeenCalled();
    await act(async () => button('Make box a machine').click());
    await act(async () => button('Turn on').click());
    expect(rpc.hostControllers.enable).toHaveBeenCalledWith({
      sshHost: 'box',
      serverId: 'server-1',
      workspaceId: 'workspace-1',
    });
    expect(rpc.embeddedController.enable).not.toHaveBeenCalled();
  });
});

describe('turning this computer on for switch-buddy', () => {
  it('waits for the person to confirm before turning it on', async () => {
    const onTurnOn = vi.fn();
    await act(async () =>
      root.render(
        createElement(ComputerNote, {
          serverId: 'server-1',
          computer: { kind: 'off' },
          onRetry: vi.fn(),
          onTurnOn,
        })
      )
    );
    expect(container.textContent).toContain('does not run managed agents for this workspace yet');
    await act(async () => button('Run managed agents on this computer').click());
    expect(onTurnOn).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Acme (switch.example.com) can then start');
    await act(async () => button('Turn on').click());
    expect(onTurnOn).toHaveBeenCalledTimes(1);
  });
});

describe('machineConsent', () => {
  it('says which server can then run agents, and where', () => {
    expect(machineConsent({ server: 'Acme', label: 'This computer', sshHost: null })).toEqual({
      title: 'Run managed agents on this computer?',
      text: expect.stringContaining('Acme can then start, change and stop agents on this computer'),
    });
    expect(machineConsent({ server: 'Acme', label: 'box', sshHost: 'box' }).text).toContain(
      'Acme can then start, change and stop agents on box'
    );
  });

  it('names a server by its name, with its address when that says more', () => {
    expect(serverForConsent({ name: 'Acme', url: 'https://switch.example.com' })).toBe(
      'Acme (switch.example.com)'
    );
    expect(
      serverForConsent({ name: 'switch.example.com', url: 'https://switch.example.com' })
    ).toBe('switch.example.com');
    expect(serverForConsent(null)).toBe('this Switch server');
  });
});
