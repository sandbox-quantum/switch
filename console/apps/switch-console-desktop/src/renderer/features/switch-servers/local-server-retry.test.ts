import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  detectDocker: vi.fn().mockResolvedValue({ available: true, version: '29' }),
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { localSwitchServer: mocks },
  events: { on: () => () => {} },
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({ agentsStore: {} }));
vi.mock('./switch-servers-store', () => ({ switchServersStore: { init: vi.fn() } }));
import { LocalServerStore } from './local-server-store';
it('restores Docker readiness after a failed pull so setup can retry', async () => {
  mocks.start.mockResolvedValue({ kind: 'error', message: 'Image download failed' });
  const store = new LocalServerStore();
  await store.start();
  expect(store.docker).toMatchObject({ available: true });
  expect(store.isTransitioning).toBe(false);
  expect(store.error).toBe('Image download failed');
  await store.start();
  expect(mocks.start).toHaveBeenCalledTimes(2);
});
