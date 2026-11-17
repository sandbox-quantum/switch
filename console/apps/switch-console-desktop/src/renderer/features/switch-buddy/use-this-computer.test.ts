// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';

const rpc = vi.hoisted(() => ({
  embeddedController: {
    getOverview: vi.fn(),
    enable: vi.fn(),
    recheckProviders: vi.fn(),
    precheckedProviders: vi.fn(async () => []),
  },
  managedAgents: { machines: vi.fn(async () => []) },
}));
vi.mock('@renderer/lib/ipc', () => ({ rpc }));
vi.mock('@renderer/features/managed-agents/use-managed-agents', () => ({
  MANAGED_AGENTS_KEY: 'managed-agents',
}));

const { thisComputerIn, thisComputerState, useThisComputer } = await import('./use-this-computer');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function machine(kind: string | null, providers: number): OwnedMachine {
  return {
    id: `m-${kind}`,
    local: kind === null ? null : { kind },
    providers: Array.from({ length: providers }, (_, i) => ({ provider: `p${i}`, ready: true })),
  } as unknown as OwnedMachine;
}

describe('thisComputerState', () => {
  it('has failed, with why, when setting this computer up failed', () => {
    expect(thisComputerState('No Docker.', true, [machine('this-computer', 0)])).toEqual({
      kind: 'failed',
      error: 'No Docker.',
    });
    expect(thisComputerState('No Docker.', true, undefined)).toMatchObject({ kind: 'failed' });
  });

  it('is ready when this computer reports its providers after setting it up said it failed', () => {
    const mine = machine('this-computer', 2);
    expect(thisComputerState('Timed out.', true, [mine])).toEqual({ kind: 'ready', machine: mine });
  });

  it('has failed when the server runs no managed agents', () => {
    expect(thisComputerState(null, true, null)).toMatchObject({ kind: 'failed' });
  });

  it('is starting until this computer is a machine of the workspace and has reported', () => {
    expect(thisComputerState(null, true, undefined)).toEqual({ kind: 'starting' });
    expect(thisComputerState(null, true, [])).toEqual({ kind: 'starting' });
    expect(thisComputerState(null, true, [machine('remote', 3)])).toEqual({ kind: 'starting' });
    expect(thisComputerState(null, true, [machine('this-computer', 0)])).toEqual({
      kind: 'starting',
    });
  });

  it('is ready once this computer has reported its providers', () => {
    const mine = machine('this-computer', 2);
    expect(thisComputerState(null, true, [machine(null, 1), mine])).toEqual({
      kind: 'ready',
      machine: mine,
    });
  });
});

describe('thisComputerState for a computer that is not a machine', () => {
  it('is off, for the person to turn on, until it is enrolled', () => {
    expect(thisComputerState(null, false, [])).toEqual({ kind: 'off' });
    expect(thisComputerState(null, false, undefined)).toEqual({ kind: 'off' });
    expect(thisComputerState(null, null, [])).toEqual({ kind: 'starting' });
  });

  it('is starting when it is among the machines although it read as not enrolled', () => {
    expect(thisComputerState(null, false, [machine('this-computer', 0)])).toEqual({
      kind: 'starting',
    });
  });
});

describe('useThisComputer', () => {
  async function mounted() {
    const seen: { current: ReturnType<typeof useThisComputer> | null } = { current: null };
    function Probe() {
      seen.current = useThisComputer('s1', 'w1');
      return null;
    }
    const root = createRoot(document.createElement('div'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
    });
    return { seen, root };
  }

  it('never turns this computer on by itself, and does once turnOn is called', async () => {
    rpc.embeddedController.getOverview.mockResolvedValue({
      unsupportedReason: null,
      enrollment: null,
    });
    rpc.embeddedController.enable.mockResolvedValue(undefined);
    const { seen, root } = await mounted();
    expect(seen.current?.state).toEqual({ kind: 'off' });
    expect(rpc.embeddedController.enable).not.toHaveBeenCalled();

    await act(async () => {
      await seen.current?.turnOn();
    });
    expect(rpc.embeddedController.enable).toHaveBeenCalledWith({
      serverId: 's1',
      workspaceId: 'w1',
    });
    expect(seen.current?.state).toEqual({ kind: 'starting' });
    await act(async () => root.unmount());
  });

  it('follows a computer that is already enrolled without enrolling it again', async () => {
    rpc.embeddedController.enable.mockClear();
    rpc.embeddedController.getOverview.mockResolvedValue({
      unsupportedReason: null,
      enrollment: { controllerId: 'c1', name: 'laptop' },
    });
    const { seen, root } = await mounted();
    expect(seen.current?.state).toEqual({ kind: 'starting' });
    expect(rpc.embeddedController.enable).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});

describe('thisComputerIn', () => {
  it('finds this computer among the machines, or nothing', () => {
    const mine = machine('this-computer', 0);
    expect(thisComputerIn([machine('remote', 1), mine])).toBe(mine);
    expect(thisComputerIn([machine('remote', 1)])).toBeNull();
    expect(thisComputerIn(undefined)).toBeNull();
  });
});
