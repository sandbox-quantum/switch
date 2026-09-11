import { expect, it, vi } from 'vitest';
import { LocationProvider } from './location-provider';

const mocks = vi.hoisted(() => ({
  sessions: vi.fn(async () => {}),
  terminals: vi.fn(async () => {}),
}));
vi.mock('../sessions/session-runtime-manager', () => ({
  sessionRuntimeManager: { teardownAllForLocation: mocks.sessions },
}));
vi.mock('./location-runtime-registry', () => ({
  locationRuntimeRegistry: { releaseAll: mocks.terminals },
}));

it('awaited Console disposal detaches local SDK sessions with tmux disabled', async () => {
  const location = new LocationProvider(
    { id: 'local', name: 'Local', dir: '/workspace', sshHost: null, createdAt: '', updatedAt: '' },
    { kind: 'local' },
    {
      ctx: {} as never,
      fs: {} as never,
      settings: { get: async () => ({ tmux: false }) } as never,
    }
  );
  await location.dispose();
  expect(mocks.sessions).toHaveBeenCalledWith('local', 'detach');
  expect(mocks.terminals).toHaveBeenCalledWith('local', 'terminate');
});
