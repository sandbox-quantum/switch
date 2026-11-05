// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allFeatureFlagsOff,
  type ServerFeatureFlags,
} from '@shared/core/feature-flags/feature-flags';

// Your cloud files in the renderer: hidden unless the server says so, and a
// resting box woken only by the person's click, with exactly one ensure.

const flagsState = new Map<string, ServerFeatureFlags>();
const list = vi.fn();
const ensureCloudMachine = vi.fn();
const machines = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: {
    featureFlags: {
      get: async (serverId: string) => ({ success: true, data: flagsState.get(serverId) }),
      refresh: vi.fn(async () => ({ success: true, data: undefined })),
    },
    cloudFiles: { list: (...args: unknown[]) => list(...args) },
    switchServers: { ensureCloudMachine: (...args: unknown[]) => ensureCloudMachine(...args) },
  },
}));
vi.mock('@renderer/features/cloud-agents/use-cloud-agents', () => ({
  // Answers whatever it's asked, so the flags alone must hide the view.
  useCloudMachines: () => ({ data: machines.data }),
}));
vi.mock('@renderer/features/managed-agents/use-managed-agents', () => ({
  MANAGED_AGENTS_KEY: 'managed-agents',
}));

const { useCloudFilesVisible, useCloudFolder, WAKE_FAILED_MESSAGE, WAKE_RETRY_MS } =
  await import('./use-cloud-files');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flags = (serverId: string, over: { v2?: boolean; files?: boolean; error?: string }) => ({
  serverId,
  flags: {
    ...allFeatureFlagsOff(),
    hosted_v2: over.v2 ?? true,
    hosted_cloud_files: over.files ?? true,
  },
  fetchedAt: over.error ? null : 1,
  error: over.error ?? null,
});
const BOX_WITH_AGENT = [{ backend: 'box', agents: ['a1'], controller_id: 'c1' }];

async function mount<T>(hook: () => T) {
  const seen = {} as { value: T };
  const root = createRoot(document.createElement('div'));
  function Probe() {
    seen.value = hook();
    return null;
  }
  await act(async () => root.render(createElement(Probe)));
  return { seen, done: () => act(() => root.unmount()) };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('useCloudFilesVisible', () => {
  it('shows with a good read, both flags on, and a hosted agent', async () => {
    flagsState.set('s1', flags('s1', {}));
    machines.data = BOX_WITH_AGENT;
    const view = await mount(() => useCloudFilesVisible('s1'));
    expect(view.seen.value).toBe(true);
    view.done();
  });

  it.each([
    ['hosted_cloud_files off', flags('s2', { files: false }), BOX_WITH_AGENT],
    ['hosted_v2 off', flags('s2', { v2: false }), BOX_WITH_AGENT],
    ['a failed read', flags('s2', { error: 'down' }), BOX_WITH_AGENT],
    ['no hosted agent', flags('s2', {}), [{ backend: 'box', agents: [], controller_id: 'c1' }]],
    [
      'a v1 machine only',
      flags('s2', {}),
      [{ backend: 'vm', agents: ['a1'], controller_id: 'c1' }],
    ],
  ])('hidden with %s, and no route is called', async (_label, state, data) => {
    flagsState.set('s2', state);
    machines.data = data;
    const view = await mount(() => useCloudFilesVisible('s2'));
    expect(view.seen.value).toBe(false);
    expect(list).not.toHaveBeenCalled();
    view.done();
  });
});

describe('useCloudFolder', () => {
  it('loads a folder, then the next page by its cursor', async () => {
    list.mockResolvedValueOnce({
      ok: true,
      value: { entries: [{ name: 'a', kind: 'file', size: 1, mtime: 1 }], cursor: 'c2' },
    });
    list.mockResolvedValueOnce({
      ok: true,
      value: { entries: [{ name: 'b', kind: 'file', size: 1, mtime: 1 }] },
    });
    const view = await mount(() => useCloudFolder('s1', 'shared', true));
    expect(view.seen.value.state).toMatchObject({ kind: 'ready', more: true });
    await act(async () => view.seen.value.loadMore());
    expect(view.seen.value.state).toMatchObject({ kind: 'ready', more: false });
    expect(
      (view.seen.value.state as { entries: { name: string }[] }).entries.map((e) => e.name)
    ).toEqual(['a', 'b']);
    expect(list).toHaveBeenLastCalledWith({ serverId: 's1', path: 'shared', cursor: 'c2' });
    view.done();
  });

  it('calls nothing while not enabled', async () => {
    const view = await mount(() => useCloudFolder('s1', '', false));
    expect(list).not.toHaveBeenCalled();
    view.done();
  });

  it('a resting box is woken only by the click: exactly one ensure, then the listing loads', async () => {
    vi.useFakeTimers();
    list.mockResolvedValueOnce({ ok: false, code: 'box_resting' });
    const view = await mount(() => useCloudFolder('s1', '', true));
    expect(view.seen.value.state).toEqual({ kind: 'resting' });
    expect(ensureCloudMachine).not.toHaveBeenCalled();

    ensureCloudMachine.mockResolvedValueOnce({});
    list.mockResolvedValueOnce({ ok: false, code: 'box_resting' });
    list.mockResolvedValueOnce({ ok: true, value: { entries: [] } });
    let waking!: Promise<void>;
    await act(async () => {
      waking = view.seen.value.wake();
    });
    expect(view.seen.value.state).toEqual({ kind: 'waking' });
    await act(async () => view.seen.value.wake()); // a second click does nothing
    await act(async () => vi.advanceTimersByTimeAsync(WAKE_RETRY_MS * 2));
    await act(async () => waking);
    expect(view.seen.value.state).toMatchObject({ kind: 'ready' });
    expect(ensureCloudMachine).toHaveBeenCalledTimes(1);
    view.done();
  });

  it('a refused wake says so plainly and does not try again', async () => {
    list.mockResolvedValueOnce({ ok: false, code: 'box_resting' });
    const view = await mount(() => useCloudFolder('s1', '', true));
    ensureCloudMachine.mockRejectedValueOnce(new Error('paused'));
    await act(async () => view.seen.value.wake());
    expect(view.seen.value.state).toEqual({
      kind: 'error',
      code: 'wake_failed',
      message: WAKE_FAILED_MESSAGE,
    });
    await act(async () => view.seen.value.wake());
    expect(ensureCloudMachine).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    view.done();
  });

  it('any other refusal shows its plain message', async () => {
    list.mockResolvedValueOnce({ ok: false, code: 'not_found' });
    const view = await mount(() => useCloudFolder('s1', 'gone', true));
    expect(view.seen.value.state).toEqual({
      kind: 'error',
      code: 'not_found',
      message: 'That file or folder isn’t there any more.',
    });
    view.done();
  });
});
