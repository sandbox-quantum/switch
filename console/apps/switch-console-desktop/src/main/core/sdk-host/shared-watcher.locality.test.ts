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
const { controllerConnectionId } = await import('@main/core/switch-rooms/session-connection-id');

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
  await configureSharedWatcher('agent-1', true, 'explicit');
  expect(mocks.startLocal).toHaveBeenCalled();
  expect(mocks.deploy).not.toHaveBeenCalled();
  expect(mocks.runCommand).not.toHaveBeenCalled();
});

it('gives the watcher the agent’s controller connection, not a fresh one', async () => {
  mocks.location.mockResolvedValue({ id: 'local', dir: '/work', sshHost: null });
  await configureSharedWatcher('agent-1', true, 'explicit');
  // Derived from the Switch agent id, so a second Console watching this agent
  // reopens this connection rather than opening one the server cannot tell is
  // the same role.
  expect(mocks.startLocal.mock.calls[0][0].roomConnection).toEqual({
    connectionId: controllerConnectionId('switch-agent-1'),
  });
});

it('stops a local agent through Console rather than a deployed host', async () => {
  mocks.location.mockResolvedValue({ id: 'local', dir: '/work', sshHost: null });
  await configureSharedWatcher('agent-1', false, 'explicit');
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
  await configureSharedWatcher('agent-1', true, 'explicit');
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

it.each([
  // A restore is nobody asking for this watcher back, so a host that stood down
  // after a takeover stays down across a Console restart. An explicit start is
  // somebody asking, and clears the marker on the same hop.
  ['restore', true, 'false'],
  ['explicit', true, 'true'],
  ['restore', false, 'true'],
] as const)(
  'tells an SSH host whether a %s to enabled=%s clears standing down',
  async (intent, enabled, clear) => {
    mocks.location.mockResolvedValue({ id: 'remote', dir: '/work', sshHost: 'builder' });
    await configureSharedWatcher('agent-1', enabled, intent);
    const write = mocks.exec.mock.calls.find((call) => call[1][1].includes('taken-over.json'));
    expect(write?.[1].slice(2)).toEqual(['/state/watcher', String(enabled), clear]);
  }
);
