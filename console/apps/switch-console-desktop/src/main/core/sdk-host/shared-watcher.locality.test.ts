import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  location: vi.fn(),
  deploy: vi.fn(),
  runCommand: vi.fn(),
  startLocal: vi.fn(),
  stopLocal: vi.fn(),
  exec: vi.fn(),
  stopped: vi.fn(),
  spawning: vi.fn(),
  removeRoots: vi.fn(),
  agentById: vi.fn(),
  ssh: vi.fn(),
}));

vi.mock('@main/core/switch-rooms/auto-session-store', () => ({
  listStoppedControllerAgentIds: mocks.stopped,
  listAutoSessionAgentIds: mocks.spawning,
}));

vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: mocks.agentById }));
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({ ensureSshConnected: mocks.ssh }));
vi.mock('@main/core/execution-context/ssh-execution-context', () => ({
  SshExecutionContext: class {
    exec = mocks.exec;
  },
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
vi.mock('./watcher-inspection', () => ({
  waitForWatcherStop: 'wait',
  removeWatcherRoots: 'fs.rmSync(root)',
}));
vi.mock('./adopt-subagent', () => ({ adoptSubagent: vi.fn() }));
vi.mock('./local-host', () => ({
  startLocalWatcher: mocks.startLocal,
  stopLocalWatcher: mocks.stopLocal,
  removeLocalWatcherRoots: mocks.removeRoots,
}));

const { applyControllerState, configureSharedWatcher, discardControllerState } =
  await import('./shared-watcher');
const { controllerConnectionId } = await import('@main/core/switch-rooms/session-connection-id');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deploy.mockResolvedValue({
    ctx: { exec: mocks.exec },
    root: '/state/watcher',
    entrypoint: 'shared-host.mjs',
  });
  mocks.exec.mockResolvedValue({ stdout: '' });
  mocks.stopped.mockResolvedValue([]);
  mocks.spawning.mockResolvedValue([]);
  mocks.agentById.mockResolvedValue({
    id: 'agent-1',
    name: 'scout',
    switchAgentId: 'switch-agent-1',
    providerId: 'claude',
  });
});

it('watches a local agent inside Console without deploying a host', async () => {
  mocks.location.mockResolvedValue({ id: 'local', dir: '/work', sshHost: null });
  await configureSharedWatcher('agent-1', { connected: true, spawning: true }, 'explicit');
  expect(mocks.startLocal).toHaveBeenCalled();
  expect(mocks.deploy).not.toHaveBeenCalled();
  expect(mocks.runCommand).not.toHaveBeenCalled();
});

it('gives the watcher the agent’s controller connection, not a fresh one', async () => {
  mocks.location.mockResolvedValue({ id: 'local', dir: '/work', sshHost: null });
  await configureSharedWatcher('agent-1', { connected: true, spawning: true }, 'explicit');
  // Derived from the Switch agent id, so a second Console watching this agent
  // reopens this connection rather than opening one the server cannot tell is
  // the same role.
  expect(mocks.startLocal.mock.calls[0][0].roomConnection).toEqual({
    connectionId: controllerConnectionId('switch-agent-1'),
  });
});

it('stops a local agent through Console rather than a deployed host', async () => {
  mocks.location.mockResolvedValue({ id: 'local', dir: '/work', sshHost: null });
  await configureSharedWatcher('agent-1', { connected: false, spawning: false }, 'explicit');
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
  await configureSharedWatcher('agent-1', { connected: true, spawning: true }, 'explicit');
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
  'tells an SSH host whether a %s to connected=%s clears standing down',
  async (intent, connected, clear) => {
    mocks.location.mockResolvedValue({ id: 'remote', dir: '/work', sshHost: 'builder' });
    await configureSharedWatcher('agent-1', { connected, spawning: connected }, intent);
    const write = mocks.exec.mock.calls.find((call) => call[1][1].includes('taken-over.json'));
    expect(write?.[1].slice(2)).toEqual([
      '/state/watcher',
      String(connected),
      String(connected),
      clear,
    ]);
  }
);

it('tells an SSH host to connect without spawning when auto-start is off', async () => {
  mocks.location.mockResolvedValue({ id: 'remote', dir: '/work', sshHost: 'builder' });
  await configureSharedWatcher('agent-1', { connected: true, spawning: false }, 'explicit');
  const write = mocks.exec.mock.calls.find((call) => call[1][1].includes('taken-over.json'));
  expect(write?.[1].slice(2)).toEqual(['/state/watcher', 'true', 'false', 'true']);
});

it('passes the spawn decision to a local watcher', async () => {
  mocks.location.mockResolvedValue({ id: 'local', dir: '/work', sshHost: null });
  await configureSharedWatcher('agent-1', { connected: true, spawning: false }, 'explicit');
  expect(mocks.startLocal.mock.calls[0][1]).toEqual({ intent: 'explicit', spawning: false });
});

it.each([true, false])(
  'connects an agent nobody stopped, spawning only when auto-start is %s',
  async (autoStart) => {
    mocks.location.mockResolvedValue({ id: 'local', dir: '/work', sshHost: null });
    mocks.spawning.mockResolvedValue(autoStart ? ['agent-1'] : []);
    await applyControllerState('agent-1', 'restore');
    expect(mocks.startLocal.mock.calls[0][1]).toEqual({ intent: 'restore', spawning: autoStart });
  }
);

it('discards a local agent’s controller state inside Console', async () => {
  mocks.location.mockResolvedValue({ id: 'local', dir: '/work', sshHost: null });
  await discardControllerState('agent-1');
  expect(mocks.removeRoots).toHaveBeenCalledWith('switch-agent-1');
  expect(mocks.exec).not.toHaveBeenCalled();
});

it('discards a deployed agent’s controller state on the host that holds it', async () => {
  mocks.location.mockResolvedValue({ id: 'remote', dir: '/work', sshHost: 'builder' });
  await discardControllerState('agent-1');
  expect(mocks.removeRoots).not.toHaveBeenCalled();
  // Removed by the Switch identity the roots are keyed and journalled under,
  // not by the local agent row that is about to disappear.
  expect(mocks.exec).toHaveBeenCalledWith('node', [
    '-e',
    expect.stringContaining('rmSync'),
    'switch-agent-1',
  ]);
});

it('has no controller state to discard for an agent never linked to Switch', async () => {
  mocks.agentById.mockResolvedValue({ id: 'agent-1', name: 'scout', switchAgentId: null });
  await discardControllerState('agent-1');
  expect(mocks.removeRoots).not.toHaveBeenCalled();
  expect(mocks.exec).not.toHaveBeenCalled();
  expect(mocks.location).not.toHaveBeenCalled();
});

it('leaves a stopped controller off the air however auto-start is set', async () => {
  mocks.location.mockResolvedValue({ id: 'local', dir: '/work', sshHost: null });
  mocks.stopped.mockResolvedValue(['agent-1']);
  mocks.spawning.mockResolvedValue(['agent-1']);
  await applyControllerState('agent-1', 'restore');
  expect(mocks.stopLocal).toHaveBeenCalledWith('switch-agent-1');
  expect(mocks.startLocal).not.toHaveBeenCalled();
});
