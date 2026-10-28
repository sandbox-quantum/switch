import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The local setup step asks for Docker on open, on a timer and on window focus.
 * Two checks in flight could finish out of order and leave an older "not
 * running" on screen after a newer "available", so the store runs one at a time.
 */

const detectDocker = vi.fn();
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { localSwitchServer: { detectDocker: () => detectDocker() } },
  events: { on: () => () => {} },
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({ agentsStore: {} }));
vi.mock('./switch-servers-store', () => ({
  switchServersStore: { init: () => Promise.resolve() },
}));

import { LocalServerStore } from './local-server-store';

beforeEach(() => {
  detectDocker.mockReset();
});

describe('checking for Docker', () => {
  it('shares one check between callers while it is in flight', async () => {
    let answer: (value: unknown) => void = () => {};
    detectDocker.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const store = new LocalServerStore();

    const first = store.checkDocker();
    const second = store.checkDocker();
    answer({ available: true });
    await Promise.all([first, second]);

    expect(detectDocker).toHaveBeenCalledTimes(1);
    expect(store.docker).toEqual({ available: true });
  });

  it('asks again once the previous check has finished', async () => {
    detectDocker
      .mockResolvedValueOnce({ available: false, reason: 'daemon', detail: 'not running' })
      .mockResolvedValueOnce({ available: true });
    const store = new LocalServerStore();

    await store.checkDocker();
    expect(store.docker).toMatchObject({ available: false });
    await store.checkDocker();

    expect(detectDocker).toHaveBeenCalledTimes(2);
    expect(store.docker).toEqual({ available: true });
  });
});
