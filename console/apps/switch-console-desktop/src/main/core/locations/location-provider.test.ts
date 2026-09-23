import { expect, it, vi } from 'vitest';
import { LocationProvider } from './location-provider';

const mocks = vi.hoisted(() => ({
  sessions: vi.fn(async () => {}),
  locations: vi.fn(async () => {}),
}));
vi.mock('../sessions/session-runtime-manager', () => ({
  sessionRuntimeManager: { teardownAllForLocation: mocks.sessions },
}));
vi.mock('./location-runtime-registry', () => ({
  locationRuntimeRegistry: { releaseAll: mocks.locations },
}));

it('awaited Console disposal detaches local SDK sessions', async () => {
  const location = new LocationProvider(
    {
      id: 'local',
      name: 'Local',
      dir: '/workspace',
      sshHost: null,
      observed: false,
      observedOwner: null,
      createdAt: '',
      updatedAt: '',
    },
    { kind: 'local' },
    {
      ctx: {} as never,
      fs: {} as never,
      settings: { get: async () => ({}) } as never,
    }
  );
  await location.dispose();
  expect(mocks.sessions).toHaveBeenCalledWith('local', 'detach');
  expect(mocks.locations).toHaveBeenCalledWith('local', 'detach');
});
