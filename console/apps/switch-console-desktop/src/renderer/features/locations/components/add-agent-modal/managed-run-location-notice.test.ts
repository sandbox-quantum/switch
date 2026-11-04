// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { NewAgentMachine } from '@shared/core/agent-migration/agent-migration';

// The Add agent form's run location: on a server with hosted agents v2 on, this
// computer is made a machine only when the person clicks (B38, ask first).

const enable = vi.fn(async () => {});
const hostEnable = vi.fn(async () => {});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: {
    embeddedController: { enable },
    hostControllers: { enable: hostEnable },
  },
}));

const { ManagedRunLocationNotice } = await import('./managed-run-location-notice');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOT_A_MACHINE: NewAgentMachine = {
  management: true,
  target: null,
  blocker: 'This computer is not a machine on this server yet.',
  canEnable: true,
};

async function show(autoEnable: boolean | undefined) {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(ManagedRunLocationNotice, {
          machine: NOT_A_MACHINE,
          label: 'This computer',
          sshHost: null,
          serverId: 's1',
          workspaceId: 'w1',
          onEnabled: () => {},
          ...(autoEnable === undefined ? {} : { autoEnable }),
        })
      )
    );
  });
  return { container, root };
}

describe('ManagedRunLocationNotice', () => {
  it('with v2 on (no auto turn-on): choosing this computer turns nothing on', async () => {
    vi.clearAllMocks();
    const { container, root } = await show(false);
    expect(enable).not.toHaveBeenCalled();
    // The machine's own button is there to do it.
    expect(container.textContent).toContain('Run managed agents on this computer');
    act(() => root.unmount());
  });

  it('with v2 on: the button turns this computer on, once', async () => {
    vi.clearAllMocks();
    const { container, root } = await show(false);
    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Run managed agents on this computer')
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(enable).toHaveBeenCalledTimes(1);
    expect(enable).toHaveBeenCalledWith({ serverId: 's1', workspaceId: 'w1' });
    act(() => root.unmount());
  });

  it('with v2 off it turns on by itself, as upstream (and by default)', async () => {
    vi.clearAllMocks();
    const { root } = await show(true);
    expect(enable).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    vi.clearAllMocks();
    const second = await show(undefined);
    expect(enable).toHaveBeenCalledTimes(1);
    act(() => second.root.unmount());
  });
});
