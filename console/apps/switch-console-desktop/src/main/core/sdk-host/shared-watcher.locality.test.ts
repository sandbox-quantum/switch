import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  location: vi.fn(),
  deploy: vi.fn(),
  runCommand: vi.fn(),
  startLocal: vi.fn(),
  stopLocal: vi.fn(),
  exec: vi.fn(),
}));

vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: async () => ({
    id: 'agent-1',
    name: 'scout',
    switchAgentId: 'switch-agent-1',
    providerId: 'claude',
  }),
}));
vi.mock('@main/core/agents/agent-location', () => ({ getAgentLocation: mocks.location }));
vi.mock('@main/core/agents/updateAgent', () => ({ updateAgent: vi.fn() }));
vi.mock('@main/core/locations/location-manager', () => ({
  locationManager: {
    openLocation: async () => ({ success: true, data: { fs: {}, settings: {} } }),
  },
}));
vi.mock('@main/core/locations/location-runtime-factory', () => ({
  resolveSessionEnv: async () => ({ sessionEnvVars: {} }),
}));
vi.mock('./shared-agent-runtime', () => ({
  buildSharedHostConfig: async () => ({
    session: { sessionId: 'watcher', agentId: 'switch-agent-1' },
    execution: { credentialsPath: '/work/.switch/agents/scout.json' },
  }),
}));
vi.mock('./shared-host-deployment', () => ({
  deploySharedHost: mocks.deploy,
  runSharedHostCommand: mocks.runCommand,
}));
vi.mock('./watcher-inspection', () => ({ waitForWatcherStop: 'wait' }));
vi.mock('./adopt-subagent', () => ({ adoptSubagent: vi.fn() }));
vi.mock('./local-host', () => ({
  startLocalWatcher: mocks.startLocal,
  stopLocalWatcher: mocks.stopLocal,
}));

const { configureSharedWatcher } = await import('./shared-watcher');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deploy.mockResolvedValue({
    ctx: { exec: mocks.exec },
    root: '/state/watcher',
    entrypoint: 'shared-host.mjs',
  });
  mocks.exec.mockResolvedValue({ stdout: '' });
});

it('watches a local agent inside Console without deploying a host', async () => {
  mocks.location.mockResolvedValue({ id: 'local', dir: '/work', sshHost: null });
  await configureSharedWatcher('agent-1', true);
  expect(mocks.startLocal).toHaveBeenCalled();
  expect(mocks.deploy).not.toHaveBeenCalled();
  expect(mocks.runCommand).not.toHaveBeenCalled();
});

it('stops a local agent through Console rather than a deployed host', async () => {
  mocks.location.mockResolvedValue({ id: 'local', dir: '/work', sshHost: null });
  await configureSharedWatcher('agent-1', false);
  expect(mocks.stopLocal).toHaveBeenCalledWith('switch-agent-1');
  expect(mocks.deploy).not.toHaveBeenCalled();
});

it('still deploys the shared host for an agent on an SSH host', async () => {
  mocks.location.mockResolvedValue({
    id: 'remote',
    dir: '/work',
    sshHost: 'builder',
    connectionId: 'connection-1',
  });
  await configureSharedWatcher('agent-1', true);
  expect(mocks.deploy).toHaveBeenCalled();
  expect(mocks.runCommand).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'ssh' }),
    expect.anything(),
    expect.anything(),
    '--ensure-watch',
    false
  );
  expect(mocks.startLocal).not.toHaveBeenCalled();
});

it.each([true, false])(
  'leaves the watcher of an agent another account runs alone (enabled: %s)',
  async (enabled) => {
    // It runs under the account that owns the agent (CHOO-2893): starting one
    // here would run it as the wrong person, and stopping it would switch off
    // someone else's automatic sessions.
    mocks.location.mockResolvedValue({
      id: 'observed',
      dir: '/home/alice/reviewer',
      sshHost: 'builder',
      observed: true,
      observedOwner: 'alice',
    });

    await configureSharedWatcher('agent-1', enabled);

    expect(mocks.deploy).not.toHaveBeenCalled();
    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.startLocal).not.toHaveBeenCalled();
    expect(mocks.stopLocal).not.toHaveBeenCalled();
  }
);
