import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppIdentity from '@shared/app-identity';
import type * as EnvFile from './env-file';
import type { StackEnv } from './env-file';
import type { ServerHost } from './host/types';
import type { LocalServerSecrets } from './secret-values';
import type { StackOnHost, StackStateHost } from './stack-state';

/**
 * The start and connect paths on a host whose stack other Consoles share
 * (CHOO-2893). The rule under test throughout: a remote stack's settings are
 * the host's, a desktop's copy is a cache, and new credentials are made only
 * when the host has nothing of the stack at all — anything else locks a
 * running server out of its own database, for everyone using it.
 */

const inspectStackMock = vi.hoisted(() => vi.fn<() => Promise<StackOnHost>>());
const publishEnvMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const withdrawPublishedEnvMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const composeUpMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const composeDownMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const waitForHealthMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const readDeployedVersionMock = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ kind: 'deployed', version: '0.11.0', source: 'env-file' }))
);
const buildEnvFileMock = vi.hoisted(() => vi.fn((_params: unknown) => 'BUILT_ENV\n'));
const loadOrCreateSecretsMock = vi.hoisted(() => vi.fn());
const readSecretsMock = vi.hoisted(() => vi.fn());
const storeSecretsMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const clearSecretsMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const resolvePortsMock = vi.hoisted(() => vi.fn());
const readPersistedPortsMock = vi.hoisted(() => vi.fn());
const rememberPortsMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const ensureManagedServerMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ id: 'srv-1' })));
const passwordLoginMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ success: true })));
const logError = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());

vi.mock('@shared/app-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof AppIdentity>()),
  COMPATIBLE_SWITCH_VERSION: '0.11.0',
}));
vi.mock('@main/lib/logger', () => ({ log: { error: logError, warn: logWarn, info: vi.fn() } }));
vi.mock('./stack-state', () => ({
  inspectStack: inspectStackMock,
  publishEnv: publishEnvMock,
  withdrawPublishedEnv: withdrawPublishedEnvMock,
  unsharedStackMessage: (host: string, dir: string | null) => `unshared ${host} ${dir}`,
}));
vi.mock('./deployed-version', () => ({
  readDeployedVersion: readDeployedVersionMock,
  classifyVersionDrift: () => null,
}));
vi.mock('./compose', () => ({ composeUp: composeUpMock, composeDown: composeDownMock }));
vi.mock('./health', () => ({ waitForHealth: waitForHealthMock }));
vi.mock('./bundled-compose', () => ({ bundledComposeYaml: () => 'services: {}' }));
vi.mock('./env-file', async (importOriginal) => ({
  ...(await importOriginal<typeof EnvFile>()),
  buildEnvFile: buildEnvFileMock,
}));
vi.mock('./secrets', () => ({
  loadOrCreateSecrets: loadOrCreateSecretsMock,
  readSecrets: readSecretsMock,
  storeSecrets: storeSecretsMock,
  clearSecrets: clearSecretsMock,
}));
vi.mock('./ports', () => ({
  resolvePorts: resolvePortsMock,
  readPersistedPorts: readPersistedPortsMock,
  rememberPorts: rememberPortsMock,
  clearPorts: vi.fn(() => Promise.resolve()),
}));
vi.mock('./telemetry-consent', () => ({ telemetryConsent: () => Promise.resolve(false) }));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  ensureManagedServer: ensureManagedServerMock,
  setActiveServerId: vi.fn(() => Promise.resolve()),
}));
vi.mock('@main/core/switch-servers/auth', () => ({ passwordLogin: passwordLoginMock }));
vi.mock('@main/core/agents/resolve-servers', () => ({ resolveAgentServers: vi.fn() }));
vi.mock('./matrix-migration', () => ({
  crossesMatrixBoundary: () => false,
  runBackfill: vi.fn(),
}));

const { connectStack, resetStack, startStack } = await import('./pipeline');

const hostSecrets: LocalServerSecrets = {
  dbPassword: 'host-owner-pw',
  dbRuntimePassword: 'host-runtime-pw',
  agentRegistrationToken: 'host-agent-token',
  jwtSecretKey: 'host-jwt',
  gatewayAdminPassword: 'host-admin-pw',
  mattermostAdminPassword: 'host-mm-admin',
  mattermostUserPassword: 'host-mm-user',
};
const hostPorts = { gateway: 41000, api: 41001, mattermost: 41002, postgres: 41003 };
const cachedSecrets: LocalServerSecrets = { ...hostSecrets, gatewayAdminPassword: 'cached-pw' };
const cachedPorts = { gateway: 3300, api: 8000, mattermost: 8065, postgres: 5432 };

function present(
  overrides: Partial<Extract<StackOnHost, { kind: 'present' }>> = {},
  env: Partial<StackEnv> = {}
): StackOnHost {
  return {
    kind: 'present',
    env: { ports: hostPorts, secrets: hostSecrets, version: '0.11.0', ...env },
    raw: 'PUBLISHED_ENV\n',
    source: 'published',
    running: true,
    published: true,
    ...overrides,
  };
}

function sharedHost() {
  const writeFile = vi.fn<(relPath: string, content: string, mode?: number) => Promise<void>>(() =>
    Promise.resolve()
  );
  const establishNetworking = vi.fn(() => Promise.resolve());
  const teardownNetworking = vi.fn(() => Promise.resolve());
  const readFile = vi.fn<(relPath: string) => Promise<string | null>>(() => Promise.resolve(null));
  const sharedState = { label: 'vm-1' } as unknown as StackStateHost;
  const host = {
    label: 'vm-1',
    sharedState,
    writeFile,
    readFile,
    establishNetworking,
    teardownNetworking,
    detectDocker: () => Promise.resolve({ available: true, version: '27.0.0' }),
  } as unknown as ServerHost;
  return { host, sharedState, writeFile, readFile, establishNetworking, teardownNetworking };
}

function startOptions(host: ServerHost) {
  return {
    host,
    ref: { kind: 'remote' as const, sshHost: 'vm-1' },
    serverName: 'Team server',
    onMessage: vi.fn(),
    onLog: vi.fn(),
    signal: new AbortController().signal,
    checkoutRoot: null,
  };
}

function connectOptions(host: ServerHost) {
  return {
    host,
    ref: { kind: 'remote' as const, sshHost: 'vm-1' },
    serverName: 'Team server',
    onMessage: vi.fn(),
    signal: new AbortController().signal,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  publishEnvMock.mockResolvedValue(undefined);
  waitForHealthMock.mockResolvedValue(true);
  loadOrCreateSecretsMock.mockResolvedValue(cachedSecrets);
  resolvePortsMock.mockResolvedValue(cachedPorts);
  readSecretsMock.mockResolvedValue(null);
  readPersistedPortsMock.mockResolvedValue(null);
});

describe('starting a shared stack', () => {
  it('runs the host’s stack with the host’s settings, not this desktop’s', async () => {
    inspectStackMock.mockResolvedValue(present());
    const { host } = sharedHost();

    expect(await startStack(startOptions(host))).toMatchObject({ kind: 'started' });

    expect(buildEnvFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ secrets: hostSecrets, ports: hostPorts })
    );
    expect(loadOrCreateSecretsMock).not.toHaveBeenCalled();
    expect(resolvePortsMock).not.toHaveBeenCalled();
    // The desktop's copy is refreshed from the host, which it is a cache of.
    expect(storeSecretsMock).toHaveBeenCalledWith(host, hostSecrets);
    expect(rememberPortsMock).toHaveBeenCalledWith(host, hostPorts);
    expect(ensureManagedServerMock).toHaveBeenCalledWith(
      {
        name: 'Team server',
        gatewayUrl: 'http://localhost:41000',
        apiUrl: 'http://localhost:41001',
      },
      { kind: 'remote', sshHost: 'vm-1' }
    );
    expect(passwordLoginMock).toHaveBeenCalledWith(
      expect.anything(),
      'admin@switch.local',
      'host-admin-pw'
    );
  });

  it('brings this account’s working dir in step with the stack before checking its version', async () => {
    // Another account may have updated or reset the stack since this one last
    // wrote its own copy; the version check must read the stack's.
    inspectStackMock.mockResolvedValue(present());
    const { host, writeFile } = sharedHost();
    const order: string[] = [];
    writeFile.mockImplementation(async (name, content) => {
      order.push(`write ${name} ${content.trim()}`);
    });
    readDeployedVersionMock.mockImplementation(async () => {
      order.push('version check');
      return { kind: 'deployed', version: '0.11.0', source: 'env-file' };
    });

    await startStack(startOptions(host));

    expect(order.slice(0, 2)).toEqual(['write .env PUBLISHED_ENV', 'version check']);
  });

  it('leaves the working dir alone when that is where the settings were read from', async () => {
    inspectStackMock.mockResolvedValue(present({ source: 'working-dir', published: false }));
    const { host, writeFile } = sharedHost();

    await startStack(startOptions(host));

    expect(writeFile.mock.calls.filter(([, content]) => content === 'PUBLISHED_ENV\n')).toEqual([]);
  });

  it('publishes the .env it wrote before compose reads it', async () => {
    inspectStackMock.mockResolvedValue(present());
    const { host, sharedState } = sharedHost();
    const order: string[] = [];
    publishEnvMock.mockImplementation(async () => {
      order.push('publish');
    });
    composeUpMock.mockImplementation(async () => {
      order.push('compose up');
    });

    await startStack(startOptions(host));

    expect(publishEnvMock).toHaveBeenCalledWith(sharedState, 'BUILT_ENV\n');
    expect(order).toEqual(['publish', 'compose up']);
  });

  it('fails the start, touching no container, when the settings cannot be shared', async () => {
    inspectStackMock.mockResolvedValue(present());
    publishEnvMock.mockRejectedValue(new Error('docker run failed'));
    const { host } = sharedHost();

    await expect(startStack(startOptions(host))).rejects.toThrow('docker run failed');
    expect(composeUpMock).not.toHaveBeenCalled();
  });

  it('fills in the runtime password a pre-role-split stack never had', async () => {
    inspectStackMock.mockResolvedValue(
      present({}, { secrets: { ...hostSecrets, dbRuntimePassword: null } })
    );
    const { host } = sharedHost();

    await startStack(startOptions(host));

    const [{ secrets }] = buildEnvFileMock.mock.calls[0] as [{ secrets: LocalServerSecrets }];
    expect(secrets.dbPassword).toBe('host-owner-pw');
    expect(secrets.dbRuntimePassword).toMatch(/.{16,}/);
  });

  it('makes new credentials only on a host with nothing of the stack', async () => {
    inspectStackMock.mockResolvedValue({ kind: 'absent' });
    const { host } = sharedHost();

    await startStack(startOptions(host));

    expect(loadOrCreateSecretsMock).toHaveBeenCalledOnce();
    expect(buildEnvFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ secrets: cachedSecrets, ports: cachedPorts })
    );
    expect(publishEnvMock).toHaveBeenCalledOnce();
  });

  it('refuses another account’s unshared stack without writing anything', async () => {
    inspectStackMock.mockResolvedValue({
      kind: 'unshared',
      ownerDir: '/home/alice/.switchdash/switch-server',
      running: true,
    });
    const { host, writeFile } = sharedHost();

    expect(await startStack(startOptions(host))).toEqual({
      kind: 'error',
      message: 'unshared vm-1 /home/alice/.switchdash/switch-server',
    });
    expect(writeFile).not.toHaveBeenCalled();
    expect(publishEnvMock).not.toHaveBeenCalled();
    expect(composeUpMock).not.toHaveBeenCalled();
    expect(loadOrCreateSecretsMock).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledOnce();
  });

  it('refuses a host it cannot read when this desktop has no copy to fall back on', async () => {
    inspectStackMock.mockResolvedValue({ kind: 'unreadable', reason: 'docker ps failed' });
    const { host, writeFile } = sharedHost();

    const result = await startStack(startOptions(host));

    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(
      /Could not read .* on vm-1 \(docker ps failed\).*nothing was changed/
    );
    expect(writeFile).not.toHaveBeenCalled();
    expect(loadOrCreateSecretsMock).not.toHaveBeenCalled();
  });

  it('starts from this desktop’s copy when the host cannot be read, and says so', async () => {
    inspectStackMock.mockResolvedValue({
      kind: 'incomplete',
      source: 'working-dir',
      missing: ['JWT_SECRET_KEY'],
      // Everything the host does hold agrees with the copy.
      raw: 'GATEWAY_HOST_PORT=3300\nGATEWAY_ADMIN_PASSWORD=cached-pw\nDB_OWNER_PASSWORD=host-owner-pw\n',
      running: false,
    });
    readSecretsMock.mockResolvedValue(cachedSecrets);
    readPersistedPortsMock.mockResolvedValue(cachedPorts);
    const { host } = sharedHost();

    expect(await startStack(startOptions(host))).toMatchObject({ kind: 'started' });
    expect(buildEnvFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ secrets: cachedSecrets, ports: cachedPorts })
    );
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("this desktop's copy"),
      expect.objectContaining({ reason: 'its settings are missing JWT_SECRET_KEY' })
    );
  });

  it('refuses to fill a partial settings file from a copy of another generation', async () => {
    // The host's file lost a key after someone else reset the stack and
    // started it again; this desktop's copy is from before the reset.
    inspectStackMock.mockResolvedValue({
      kind: 'incomplete',
      source: 'published',
      missing: ['JWT_SECRET_KEY'],
      raw: 'GATEWAY_HOST_PORT=3300\nGATEWAY_ADMIN_PASSWORD=host-admin-pw\n',
      running: false,
    });
    readSecretsMock.mockResolvedValue(cachedSecrets);
    readPersistedPortsMock.mockResolvedValue(cachedPorts);
    const { host, writeFile } = sharedHost();

    const result = await startStack(startOptions(host));

    expect(result.kind === 'error' && result.message).toMatch(
      /missing JWT_SECRET_KEY.*out of date \(GATEWAY_ADMIN_PASSWORD differ.*nothing was changed/
    );
    expect(writeFile).not.toHaveBeenCalled();
    expect(publishEnvMock).not.toHaveBeenCalled();
    expect(composeUpMock).not.toHaveBeenCalled();
  });

  it('does not count a copy without its ports as one to fall back on', async () => {
    inspectStackMock.mockResolvedValue({ kind: 'unreadable', reason: 'ssh dropped' });
    readSecretsMock.mockResolvedValue(cachedSecrets);
    const { host } = sharedHost();

    expect((await startStack(startOptions(host))).kind).toBe('error');
    expect(composeUpMock).not.toHaveBeenCalled();
  });
});

describe('connecting to a shared stack', () => {
  it('joins a running stack without running compose or rewriting its settings', async () => {
    inspectStackMock.mockResolvedValue(present());
    const { host, writeFile, establishNetworking } = sharedHost();

    expect(await connectStack(connectOptions(host))).toEqual({
      kind: 'connected',
      serverId: 'srv-1',
      deployedVersion: '0.11.0',
    });

    expect(composeUpMock).not.toHaveBeenCalled();
    expect(buildEnvFileMock).not.toHaveBeenCalled();
    expect(publishEnvMock).not.toHaveBeenCalled();
    // This account's copy is the stack's own, byte for byte, so Stop and
    // Restart work from here without changing anything.
    expect(writeFile).toHaveBeenCalledWith('.env', 'PUBLISHED_ENV\n', 0o600);
    expect(writeFile).toHaveBeenCalledWith('standalone-docker-compose.yml', 'services: {}');
    expect(establishNetworking).toHaveBeenCalledWith(hostPorts);
    expect(storeSecretsMock).toHaveBeenCalledWith(host, hostSecrets);
    expect(passwordLoginMock).toHaveBeenCalledWith(
      expect.anything(),
      'admin@switch.local',
      'host-admin-pw'
    );
  });

  it('shares a stack this account started before settings were shared', async () => {
    inspectStackMock.mockResolvedValue(
      present({ source: 'working-dir', published: false, raw: 'OWN_ENV\n' })
    );
    const { host, sharedState, writeFile } = sharedHost();

    expect((await connectStack(connectOptions(host))).kind).toBe('connected');
    expect(publishEnvMock).toHaveBeenCalledWith(sharedState, 'OWN_ENV\n');
    expect(writeFile).not.toHaveBeenCalledWith('.env', expect.anything(), expect.anything());
  });

  it('leaves a compose file this account already has alone: rewriting it is a start’s job', async () => {
    inspectStackMock.mockResolvedValue(present());
    const { host, writeFile, readFile } = sharedHost();
    readFile.mockResolvedValue('services: { older: {} }');

    await connectStack(connectOptions(host));

    expect(writeFile).not.toHaveBeenCalledWith('standalone-docker-compose.yml', expect.anything());
    expect(writeFile).toHaveBeenCalledWith('.env', 'PUBLISHED_ENV\n', 0o600);
  });

  it('sends a stopped stack to Start, touching nothing', async () => {
    inspectStackMock.mockResolvedValue(present({ running: false }));
    const { host, writeFile, establishNetworking } = sharedHost();

    expect(await connectStack(connectOptions(host))).toEqual({ kind: 'not-running' });
    expect(writeFile).not.toHaveBeenCalled();
    expect(establishNetworking).not.toHaveBeenCalled();
    expect(storeSecretsMock).not.toHaveBeenCalled();
  });

  it('reports an empty host as having nothing to join', async () => {
    inspectStackMock.mockResolvedValue({ kind: 'absent' });
    const { host } = sharedHost();

    expect(await connectStack(connectOptions(host))).toEqual({ kind: 'absent' });
  });

  it('explains an unshared stack instead of joining it', async () => {
    inspectStackMock.mockResolvedValue({ kind: 'unshared', ownerDir: null, running: true });
    const { host, writeFile } = sharedHost();

    expect(await connectStack(connectOptions(host))).toEqual({
      kind: 'unshared',
      ownerDir: null,
      message: 'unshared vm-1 null',
    });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('names the keys a partial settings file is missing', async () => {
    inspectStackMock.mockResolvedValue({
      kind: 'incomplete',
      source: 'published',
      missing: ['DB_PASSWORD'],
      raw: 'DB_OWNER_PASSWORD=host-owner-pw\n',
      running: true,
    });
    const { host } = sharedHost();

    const result = await connectStack(connectOptions(host));

    expect(result.kind === 'error' && result.message).toContain('missing DB_PASSWORD');
  });

  it('says where it looked when the running stack does not answer', async () => {
    inspectStackMock.mockResolvedValue(present());
    waitForHealthMock.mockResolvedValue(false);
    const { host } = sharedHost();

    expect(await connectStack(connectOptions(host))).toEqual({
      kind: 'error',
      message:
        'The Switch server on vm-1 is running, but did not answer at http://localhost:41000.',
    });
    expect(ensureManagedServerMock).not.toHaveBeenCalled();
  });

  it('has nothing to connect to on a host whose stack nobody shares', async () => {
    const { host } = sharedHost();
    const local = { ...host, sharedState: null } as unknown as ServerHost;

    await expect(connectStack(connectOptions(local))).rejects.toThrow(/not shared/);
  });
});

describe('resetting a shared stack', () => {
  it('withdraws the published settings along with the data they opened', async () => {
    const { host, sharedState } = sharedHost();

    await resetStack(host);

    expect(composeDownMock).toHaveBeenCalledWith(host, true);
    expect(withdrawPublishedEnvMock).toHaveBeenCalledWith(sharedState);
    expect(clearSecretsMock).toHaveBeenCalledWith(host);
  });

  it('has nothing to withdraw for a stack nobody shares', async () => {
    const { host } = sharedHost();

    await resetStack({ ...host, sharedState: null } as unknown as ServerHost);

    expect(withdrawPublishedEnvMock).not.toHaveBeenCalled();
  });
});
