import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  locate: vi.fn(),
  deploy: vi.fn(),
  exec: vi.fn(),
  dispose: vi.fn(),
  plugin: {
    metadata: { name: 'Claude Code' } as { name: string; sessionStartMaySignIn?: boolean },
    capabilities: { hostDependency: { binaryNames: ['claude'] } },
    behavior: {},
  },
}));

vi.mock('@main/core/sdk-host/shared-host-deployment', () => ({
  locateSharedHost: mocks.locate,
  deploySharedHost: mocks.deploy,
}));
vi.mock('@main/core/agent-runtime/impl/resolve-agent-executable', () => ({
  resolveAgentExecutable: async () => '/usr/bin/claude',
}));
vi.mock('@switch-console/core/deps/runtime', () => ({
  resolveCommandPath: async () => '/usr/bin/claude',
}));
vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: () => mocks.plugin,
}));
vi.mock('@main/core/dependencies/host-dependency-store', () => ({ hostDependencyStore: {} }));
vi.mock('@main/core/dependencies/dependency-managers', () => ({
  localDependencyManager: { get: () => undefined },
}));
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({ ensureSshConnected: vi.fn() }));
vi.mock('@main/core/execution-context/ssh-execution-context', () => ({
  SshExecutionContext: class {
    dispose = vi.fn();
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

const { getAgentModelCatalogue, getProviderReadiness } = await import('./agent-model-catalogue');

const remote = { providerId: 'claude' as const, sshHost: 'builder', dir: '/work' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.plugin.metadata = { name: 'Claude Code' };
  mocks.exec.mockResolvedValue({
    stdout: JSON.stringify({ status: 'authenticated', message: 'Signed in', models: [] }),
  });
});

it('checks a host with the bundle already there, and never deploys one', async () => {
  mocks.locate.mockResolvedValue({
    ctx: { exec: mocks.exec, dispose: mocks.dispose },
    entrypoint: '/home/me/.local/state/switch/sdk-host/shared-host-a.mjs',
  });

  const readiness = await getProviderReadiness(remote, true);

  expect(readiness).toMatchObject({ installed: true, status: 'authenticated' });
  expect(mocks.exec.mock.calls[0]?.[1]?.[0]).toBe(
    '/home/me/.local/state/switch/sdk-host/shared-host-a.mjs'
  );
  expect(mocks.deploy).not.toHaveBeenCalled();
  expect(mocks.dispose).toHaveBeenCalled();
});

it('says Switch is not set up on a host with no bundle, rather than deploying one', async () => {
  mocks.locate.mockResolvedValue(null);

  const readiness = await getProviderReadiness(remote, true);

  expect(readiness).toMatchObject({ installed: true, status: 'unknown', models: [] });
  expect(readiness.message).toContain('builder');
  expect(mocks.deploy).not.toHaveBeenCalled();
  expect(mocks.exec).not.toHaveBeenCalled();
});

const deployedHost = () =>
  mocks.locate.mockResolvedValue({
    ctx: { exec: mocks.exec, dispose: mocks.dispose },
    entrypoint: '/home/me/.local/state/switch/sdk-host/shared-host-a.mjs',
  });
const hostModes = () => mocks.exec.mock.calls.map((call) => call[1]?.[1]);

it("lists a provider's models from its own session", async () => {
  deployedHost();
  mocks.exec.mockResolvedValue({
    stdout: JSON.stringify({
      status: 'unknown',
      message: 'Models loaded.',
      models: [{ id: 'fast', name: 'Fast' }],
    }),
  });

  const catalogue = await getAgentModelCatalogue(remote);

  expect(catalogue).toEqual({
    kind: 'available',
    models: [{ id: 'fast', name: 'Fast', variants: [] }],
  });
  expect(hostModes()).toEqual(['--models']);
});

it('asks the sign-in check first for a provider whose session start may sign in', async () => {
  mocks.plugin.metadata = { name: 'Antigravity', sessionStartMaySignIn: true };
  deployedHost();
  mocks.exec.mockResolvedValue({
    stdout: JSON.stringify({ status: 'unauthenticated', message: 'Sign in first.', models: [] }),
  });

  const catalogue = await getAgentModelCatalogue({ ...remote, providerId: 'antigravity' });

  expect(catalogue).toEqual({ kind: 'unavailable', reason: 'Sign in first.' });
  expect(hostModes()).toEqual(['--probe']);
});
