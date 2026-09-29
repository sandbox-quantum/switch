import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppIdentity from '@shared/app-identity';
import type * as DeployedVersion from './deployed-version';
import type * as EnvFile from './env-file';
import type { StackEnv } from './env-file';
import type { ServerHost } from './host/types';
import type { LocalServerSecrets } from './secret-values';
import type { ServerLease } from './stack-lock';
import type * as StackState from './stack-state';
import type { StackOnHost, StackStateHost } from './stack-state';

/**
 * The start and connect paths on a host whose stack other Consoles share
 * (CHOO-2893). The rule under test throughout: a remote stack's settings are
 * the host's, a desktop's copy is a cache, and new credentials are made only
 * when the host has nothing of the stack at all — anything else locks a
 * running server out of its own database, for everyone using it.
 */

const inspectStackMock = vi.hoisted(() => vi.fn<() => Promise<StackOnHost>>());
const publishEnvMock = vi.hoisted(() => vi.fn(() => Promise.resolve(false)));
const withdrawPublishedEnvMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const stampPublishedEnvMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const composeUpMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const composeDownMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const waitForHealthMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const readDeployedVersionMock = vi.hoisted(() =>
  vi.fn(
    (): Promise<{ kind: string; version?: string; source?: string }> =>
      Promise.resolve({ kind: 'deployed', version: '0.11.0', source: 'env-file' })
  )
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

const readRegisterMock = vi.hoisted(() => vi.fn());
vi.mock('./console-register', () => ({ readRegister: readRegisterMock }));
vi.mock('@shared/app-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof AppIdentity>()),
  COMPATIBLE_SWITCH_VERSION: '0.11.0',
}));
vi.mock('@main/lib/logger', () => ({ log: { error: logError, warn: logWarn, info: vi.fn() } }));
const currentDatabaseStampMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null> => '2026-09-01T10:00:00Z')
);
vi.mock('./stack-state', async (importOriginal) => ({
  ...(await importOriginal<typeof StackState>()),
  currentDatabaseStamp: currentDatabaseStampMock,
  inspectStack: inspectStackMock,
  publishEnv: publishEnvMock,
  stampPublishedEnv: stampPublishedEnvMock,
  withdrawPublishedEnv: withdrawPublishedEnvMock,
  unsharedStackMessage: (host: string, dir: string | null) => `unshared ${host} ${dir}`,
}));
vi.mock('./deployed-version', async (importOriginal) => ({
  ...(await importOriginal<typeof DeployedVersion>()),
  readDeployedVersion: readDeployedVersionMock,
}));
vi.mock('./compose', () => ({ composeUp: composeUpMock, composeDown: composeDownMock }));
vi.mock('./health', () => ({ waitForHealth: waitForHealthMock }));
const prepareUpgradeMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock('./managed-upgrade', () => ({
  prepareUpgrade: prepareUpgradeMock,
  finishUpgrade: vi.fn(),
}));
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
const telemetryConsentMock = vi.hoisted(() => vi.fn(() => Promise.resolve(false)));
vi.mock('./telemetry-consent', () => ({ telemetryConsent: telemetryConsentMock }));
const assertManagedServerUrlFreeMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  assertManagedServerUrlFree: assertManagedServerUrlFreeMock,
  ensureManagedServer: ensureManagedServerMock,
  setActiveServerId: vi.fn(() => Promise.resolve()),
}));
vi.mock('@main/core/switch-servers/auth', () => ({ passwordLogin: passwordLoginMock }));
vi.mock('@main/core/agents/resolve-servers', () => ({ resolveAgentServers: vi.fn() }));
vi.mock('./matrix-migration', () => ({
  crossesMatrixBoundary: () => false,
  runBackfill: vi.fn(),
}));

const { adoptRunningStack, connectStack, resetStack, startStack, stopStack } =
  await import('./pipeline');

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
    runningVersion: null,
    stamp: null,
    ...overrides,
  };
}

function sharedHost() {
  const writeFile = vi.fn<(relPath: string, content: string, mode?: number) => Promise<void>>(() =>
    Promise.resolve()
  );
  const checkNetworking = vi.fn(() => Promise.resolve());
  const establishNetworking = vi.fn(() => Promise.resolve());
  const teardownNetworking = vi.fn(() => Promise.resolve());
  const readFile = vi.fn<(relPath: string) => Promise<string | null>>(() => Promise.resolve(null));
  const removeFile = vi.fn<(relPath: string) => Promise<void>>(() => Promise.resolve());
  const sharedState = { label: 'vm-1' } as unknown as StackStateHost;
  const host = {
    label: 'vm-1',
    sharedState,
    writeFile,
    readFile,
    removeFile,
    checkNetworking,
    establishNetworking,
    teardownNetworking,
    detectDocker: () => Promise.resolve({ available: true, version: '27.0.0' }),
  } as unknown as ServerHost;
  return {
    host,
    sharedState,
    writeFile,
    readFile,
    removeFile,
    checkNetworking,
    establishNetworking,
    teardownNetworking,
  };
}

/** The server lock as the supervisor hands it over: held, until a test says
 * it was taken over. */
function heldLease() {
  const assertHeld = vi.fn(() => Promise.resolve());
  const release = vi.fn(() => Promise.resolve());
  return {
    lease: { token: 'lease-token', lost: false, assertHeld, release } as unknown as ServerLease,
    assertHeld,
    release,
  };
}

let held = heldLease();

function startOptions(host: ServerHost) {
  return {
    host,
    ref: { kind: 'remote' as const, sshHost: 'vm-1' },
    serverName: 'Team server',
    activate: true,
    onMessage: vi.fn(),
    onLog: vi.fn(),
    onUpgrade: vi.fn(),
    signal: new AbortController().signal,
    checkoutRoot: null,
    lease: held.lease,
  };
}

function connectOptions(host: ServerHost) {
  return {
    host,
    ref: { kind: 'remote' as const, sshHost: 'vm-1' },
    serverName: 'Team server',
    onMessage: vi.fn(),
    signal: new AbortController().signal,
    lease: held.lease,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  held = heldLease();
  telemetryConsentMock.mockResolvedValue(false);
  readRegisterMock.mockResolvedValue({ self: 'me', consoles: [], activity: [] });
  publishEnvMock.mockResolvedValue(false);
  waitForHealthMock.mockResolvedValue(true);
  loadOrCreateSecretsMock.mockResolvedValue(cachedSecrets);
  resolvePortsMock.mockResolvedValue(cachedPorts);
  readSecretsMock.mockResolvedValue(null);
  readPersistedPortsMock.mockResolvedValue(null);
});

describe('starting a shared stack', () => {
  it('gives an account that never joined the stack a compose file before the upgrade backup reads it', async () => {
    // Found on a real host: a second account updating a stack it had never
    // joined had no compose file, and the backup refused to run without one.
    inspectStackMock.mockResolvedValue(present({}, { version: '0.10.0' }));
    const { host, writeFile } = sharedHost();

    expect(await startStack(startOptions(host))).toMatchObject({ kind: 'started' });

    const composeWrite = writeFile.mock.calls.findIndex(
      ([path]) => path === 'standalone-docker-compose.yml'
    );
    expect(composeWrite).toBeGreaterThanOrEqual(0);
    expect(writeFile.mock.invocationCallOrder[composeWrite]).toBeLessThan(
      prepareUpgradeMock.mock.invocationCallOrder[0]!
    );
  });

  it('leaves the compose file an account already has for the start to rewrite', async () => {
    inspectStackMock.mockResolvedValue(present());
    const { host, writeFile, readFile } = sharedHost();
    readFile.mockImplementation(async (path) =>
      path === 'standalone-docker-compose.yml' ? 'services: { older: {} }' : null
    );

    await startStack(startOptions(host));

    const composeWrites = writeFile.mock.calls.filter(
      ([path]) => path === 'standalone-docker-compose.yml'
    );
    // Once, by the start itself, after the backup.
    expect(composeWrites).toHaveLength(1);
  });

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

    expect(order.indexOf('write .env PUBLISHED_ENV')).toBe(0);
    expect(order.indexOf('version check')).toBeGreaterThan(0);
  });

  it('leaves the working dir alone when that is where the settings were read from', async () => {
    inspectStackMock.mockResolvedValue(present({ source: 'working-dir', published: false }));
    const { host, writeFile } = sharedHost();

    await startStack(startOptions(host));

    expect(writeFile.mock.calls.filter(([, content]) => content === 'PUBLISHED_ENV\n')).toEqual([]);
  });

  it('publishes the .env it wrote before compose reads it, and stamps it after', async () => {
    inspectStackMock.mockResolvedValue(present());
    const { host, sharedState } = sharedHost();
    const order: string[] = [];
    publishEnvMock.mockImplementation(async () => {
      order.push('publish');
      // A first start: no database volume to stamp the copy with yet.
      return false;
    });
    composeUpMock.mockImplementation(async () => {
      order.push('compose up');
    });
    stampPublishedEnvMock.mockImplementation(async () => {
      order.push('stamp');
    });

    await startStack(startOptions(host));

    expect(publishEnvMock).toHaveBeenCalledWith(sharedState, 'BUILT_ENV\n', held.lease);
    // Stamped once compose has created the database volume the copy is for.
    expect(stampPublishedEnvMock).toHaveBeenCalledWith(sharedState, held.lease);
    expect(order).toEqual(['publish', 'compose up', 'stamp']);
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

  it('refuses a host it cannot read even when this desktop holds a copy', async () => {
    // Nothing here can tell whether someone reset the stack since this copy was
    // taken, and starting from it — and publishing it — would lock everyone out.
    inspectStackMock.mockResolvedValue({ kind: 'unreadable', reason: 'published copy timed out' });
    readSecretsMock.mockResolvedValue(cachedSecrets);
    readPersistedPortsMock.mockResolvedValue(cachedPorts);
    const { host, writeFile } = sharedHost();

    const result = await startStack(startOptions(host));

    expect(result.kind === 'error' && result.message).toMatch(
      /Could not read .* on vm-1 \(published copy timed out\).*nothing was changed/
    );
    expect(writeFile).not.toHaveBeenCalled();
    expect(publishEnvMock).not.toHaveBeenCalled();
    expect(composeUpMock).not.toHaveBeenCalled();
  });

  it('fills a partial host .env from this desktop’s copy when they agree, and says so', async () => {
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
    expect(publishEnvMock).toHaveBeenCalledWith(sharedState, 'OWN_ENV\n', held.lease);
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

  it('sends an older stack to be updated, touching nothing: this Console cannot use it as it is', async () => {
    inspectStackMock.mockResolvedValue(present({}, { version: '0.10.0' }));
    const { host, writeFile, establishNetworking } = sharedHost();

    expect(await connectStack(connectOptions(host))).toEqual({
      kind: 'behind',
      deployed: '0.10.0',
      expected: '0.11.0',
    });
    expect(writeFile).not.toHaveBeenCalled();
    expect(establishNetworking).not.toHaveBeenCalled();
    expect(storeSecretsMock).not.toHaveBeenCalled();
    expect(composeUpMock).not.toHaveBeenCalled();
  });

  it('goes by the version the stack runs, not the one its settings ask for', async () => {
    // A start elsewhere published the new version and then failed: the old
    // containers still run, and joining them as current would run this Console
    // against a switch-core it cannot use.
    inspectStackMock.mockResolvedValue(
      present({ runningVersion: '0.10.0' }, { version: '0.11.0' })
    );
    const { host } = sharedHost();

    expect(await connectStack(connectOptions(host))).toEqual({
      kind: 'behind',
      deployed: '0.10.0',
      expected: '0.11.0',
    });
  });

  it('refuses a stack newer than this Console, saying to update the Console', async () => {
    inspectStackMock.mockResolvedValue(present({}, { version: '0.12.0' }));
    const { host, writeFile, establishNetworking } = sharedHost();

    const result = await connectStack(connectOptions(host));

    expect(result).toMatchObject({ kind: 'error' });
    expect(result.kind === 'error' && result.message).toMatch(
      /runs switch-core 0\.12\.0, newer than the 0\.11\.0 this Console runs.*Update Switch Console/
    );
    expect(writeFile).not.toHaveBeenCalled();
    expect(establishNetworking).not.toHaveBeenCalled();
  });

  it('joins a stack whose version cannot be compared as it is', async () => {
    inspectStackMock.mockResolvedValue(present({}, { version: 'dev-checkout' }));
    const { host } = sharedHost();

    expect((await connectStack(connectOptions(host))).kind).toBe('connected');
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

    await resetStack(host, held.lease);

    expect(composeDownMock).toHaveBeenCalledWith(host, true);
    expect(withdrawPublishedEnvMock).toHaveBeenCalledWith(sharedState, held.lease);
    expect(clearSecretsMock).toHaveBeenCalledWith(host);
  });

  it('has nothing to withdraw for a stack nobody shares', async () => {
    const { host } = sharedHost();

    await resetStack({ ...host, sharedState: null } as unknown as ServerHost, null);

    expect(withdrawPublishedEnvMock).not.toHaveBeenCalled();
  });
});

describe('starting where nothing of the stack is left', () => {
  it('drops what this account still holds of a stack that is gone before checking versions', async () => {
    // Another account updated the stack and then it was reset: the working dir
    // still names the newer version, which is no deployment to protect.
    inspectStackMock.mockResolvedValue({ kind: 'absent' });
    const { host, removeFile } = sharedHost();
    const order: string[] = [];
    removeFile.mockImplementation(async (path) => void order.push(`remove ${path}`));
    readDeployedVersionMock.mockImplementation(async () => {
      order.push('version check');
      return { kind: 'absent' };
    });

    expect(await startStack(startOptions(host))).toMatchObject({ kind: 'started' });

    expect(order.indexOf('remove .env')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('remove .env')).toBeLessThan(order.indexOf('version check'));
  });
});

describe('usage data on a shared stack', () => {
  const bobRecently = {
    self: 'me',
    consoles: [
      {
        consoleId: 'bob',
        name: 'bob@desk',
        hostAccount: 'bob',
        appVersion: '0.37.0',
        lastSeenAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    ],
    activity: [],
  };
  const telemetryOf = () => {
    const params = buildEnvFileMock.mock.calls.at(-1)?.[0] as
      | { telemetryEnabled: boolean }
      | undefined;
    if (!params) throw new Error('no .env was built');
    return params.telemetryEnabled;
  };

  it('always applies this Console’s no', async () => {
    inspectStackMock.mockResolvedValue(present({ raw: 'TELEMETRY_ENABLED=true\n' }));
    telemetryConsentMock.mockResolvedValue(false);

    await startStack(startOptions(sharedHost().host));

    expect(telemetryOf()).toBe(false);
  });

  it('does not turn sharing on over the others using the stack', async () => {
    // Someone using it said no, or never said yes; one person's yes does not
    // take that away from them.
    inspectStackMock.mockResolvedValue(present({ raw: 'TELEMETRY_ENABLED=false\n' }));
    telemetryConsentMock.mockResolvedValue(true);
    readRegisterMock.mockResolvedValue(bobRecently);

    expect(await startStack(startOptions(sharedHost().host))).toMatchObject({
      kind: 'started',
      telemetryEnabled: false,
    });
    expect(telemetryOf()).toBe(false);
  });

  it('keeps sharing on a stack that already shares', async () => {
    inspectStackMock.mockResolvedValue(present({ raw: 'TELEMETRY_ENABLED=true\n' }));
    telemetryConsentMock.mockResolvedValue(true);
    readRegisterMock.mockResolvedValue(bobRecently);

    await startStack(startOptions(sharedHost().host));

    expect(telemetryOf()).toBe(true);
    expect(readRegisterMock).not.toHaveBeenCalled();
  });

  it('applies this Console’s yes when nobody else uses the stack', async () => {
    inspectStackMock.mockResolvedValue(present({ raw: 'TELEMETRY_ENABLED=false\n' }));
    telemetryConsentMock.mockResolvedValue(true);

    await startStack(startOptions(sharedHost().host));

    expect(telemetryOf()).toBe(true);
  });

  it('keeps sharing off for a stack started afresh where others were using the one before', async () => {
    // A reset keeps the register, and whoever said no there has not changed
    // their answer by the server being reset.
    inspectStackMock.mockResolvedValue({ kind: 'absent' });
    telemetryConsentMock.mockResolvedValue(true);
    readRegisterMock.mockResolvedValue(bobRecently);

    await startStack(startOptions(sharedHost().host));

    expect(telemetryOf()).toBe(false);
  });

  it('keeps sharing off when it cannot tell who uses the stack', async () => {
    inspectStackMock.mockResolvedValue(present({ raw: 'TELEMETRY_ENABLED=false\n' }));
    telemetryConsentMock.mockResolvedValue(true);
    readRegisterMock.mockRejectedValue(new Error('no such volume'));

    await startStack(startOptions(sharedHost().host));

    expect(telemetryOf()).toBe(false);
  });
});

describe('stamping the published settings', () => {
  it('stamps after compose only a copy published before its database existed', async () => {
    inspectStackMock.mockResolvedValue(present());
    publishEnvMock.mockResolvedValue(true);

    await startStack(startOptions(sharedHost().host));

    expect(stampPublishedEnvMock).not.toHaveBeenCalled();
  });

  it('does not fail a start that happened because the stamp could not be written, and says what it leaves open', async () => {
    // compose up has restarted the stack for everyone by then; reporting a
    // failed start would strand this Console without its forward or sign-in.
    inspectStackMock.mockResolvedValue(present());
    stampPublishedEnvMock.mockRejectedValueOnce(new Error('helper container timed out'));

    const result = await startStack(startOptions(sharedHost().host));

    expect(result).toMatchObject({ kind: 'started' });
    expect(result.kind === 'started' && result.warning).toMatch(
      /could not be stamped with its database \(helper container timed out\)/
    );
    expect(logError).toHaveBeenCalledWith(
      expect.stringMatching(/could not stamp the published settings on vm-1/),
      expect.anything()
    );
  });
});

it('says what a stamp that failed with something other than an Error said', async () => {
  inspectStackMock.mockResolvedValue(present());
  stampPublishedEnvMock.mockRejectedValueOnce('volume busy');

  const result = await startStack(startOptions(sharedHost().host));

  expect(result.kind === 'started' && result.warning).toMatch(/with its database \(volume busy\)/);
});

describe('the paths a shared start or join refuses or degrades on', () => {
  it('refuses a partial host .env when this desktop holds no copy to fill it from', async () => {
    inspectStackMock.mockResolvedValue({
      kind: 'incomplete',
      source: 'published',
      missing: ['JWT_SECRET_KEY'],
      raw: 'GATEWAY_HOST_PORT=3300\n',
      running: false,
    });
    const { host, writeFile } = sharedHost();

    const result = await startStack(startOptions(host));

    expect(result.kind === 'error' && result.message).toMatch(
      /Could not read .* on vm-1 \(its settings are missing JWT_SECRET_KEY\).*nothing was changed/
    );
    expect(writeFile).not.toHaveBeenCalled();
    expect(composeUpMock).not.toHaveBeenCalled();
  });

  it('starts a stack whose automatic sign-in fails, leaving the sign-in to the page', async () => {
    // The stack is up and healthy; only the silent sign-in did not take.
    inspectStackMock.mockResolvedValue(present());
    passwordLoginMock.mockResolvedValueOnce({ success: false, error: 'bad password' } as never);

    expect(await startStack(startOptions(sharedHost().host))).toMatchObject({ kind: 'started' });
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringMatching(/auto sign-in failed/),
      expect.objectContaining({ error: 'bad password' })
    );
  });

  it('has nothing to adopt on a host whose stack nobody shares', async () => {
    const { host } = sharedHost();
    const local = { ...host, sharedState: null } as unknown as ServerHost;
    const stack = present();

    await expect(
      adoptRunningStack(local, stack as Extract<StackOnHost, { kind: 'present' }>, held.lease)
    ).rejects.toThrow(/not shared/);
  });

  it('reports Docker being unavailable before looking to join', async () => {
    const { host } = sharedHost();
    const noDocker = {
      ...host,
      detectDocker: () =>
        Promise.resolve({ available: false, reason: 'daemon-down', detail: 'no daemon' }),
    } as unknown as ServerHost;

    expect(await connectStack(connectOptions(noDocker))).toEqual({
      kind: 'docker-unavailable',
      reason: 'daemon-down',
      detail: 'no daemon',
    });
    expect(inspectStackMock).not.toHaveBeenCalled();
  });

  it('says why it cannot join a host whose settings cannot be read', async () => {
    inspectStackMock.mockResolvedValue({ kind: 'unreadable', reason: 'docker ps timed out' });

    expect(await connectStack(connectOptions(sharedHost().host))).toEqual({
      kind: 'error',
      message: "Could not read the Switch server's settings on vm-1: docker ps timed out",
    });
  });
});

describe('the server lock through a start, a join, a stop and a reset', () => {
  it('refuses to change a shared stack without holding its lock', async () => {
    await expect(startStack({ ...startOptions(sharedHost().host), lease: null })).rejects.toThrow(
      /without holding its lock/
    );

    expect(inspectStackMock).not.toHaveBeenCalled();
    expect(composeUpMock).not.toHaveBeenCalled();
  });

  it('checks the lock is still its own before running compose', async () => {
    inspectStackMock.mockResolvedValue({ kind: 'absent' });
    const order: string[] = [];
    held.assertHeld.mockImplementation(async () => void order.push('check'));
    composeUpMock.mockImplementation(async () => void order.push('compose up'));

    await startStack(startOptions(sharedHost().host));

    expect(order).toEqual(['check', 'compose up']);
  });

  it('publishes nothing and runs nothing once the lock was taken over while it was away', async () => {
    inspectStackMock.mockResolvedValue({ kind: 'absent' });
    held.assertHeld.mockRejectedValueOnce(new Error('lock taken over'));

    await expect(startStack(startOptions(sharedHost().host))).rejects.toThrow('lock taken over');

    expect(publishEnvMock).not.toHaveBeenCalled();
    expect(composeUpMock).not.toHaveBeenCalled();
  });

  it('gives the lock back once a join has read the stack, before waiting for it to answer', async () => {
    inspectStackMock.mockResolvedValue(present());
    const order: string[] = [];
    held.release.mockImplementation(async () => void order.push('release'));
    waitForHealthMock.mockImplementation(async () => {
      order.push('health');
      return true;
    });

    expect(await connectStack(connectOptions(sharedHost().host))).toMatchObject({
      kind: 'connected',
    });
    expect(order).toEqual(['release', 'health']);
  });

  it('stops nothing when the lock was taken over before the stop', async () => {
    held.assertHeld.mockRejectedValueOnce(new Error('lock taken over'));

    await expect(stopStack(sharedHost().host, held.lease)).rejects.toThrow('lock taken over');

    expect(composeDownMock).not.toHaveBeenCalled();
  });

  it('resets nothing when the lock was taken over before the reset', async () => {
    held.assertHeld.mockRejectedValueOnce(new Error('lock taken over'));

    await expect(resetStack(sharedHost().host, held.lease)).rejects.toThrow('lock taken over');

    expect(composeDownMock).not.toHaveBeenCalled();
    expect(withdrawPublishedEnvMock).not.toHaveBeenCalled();
    expect(clearSecretsMock).not.toHaveBeenCalled();
  });

  it('stops a stack nobody shares with no lock at all', async () => {
    const local = { ...sharedHost().host, sharedState: null } as unknown as ServerHost;

    await stopStack(local, null);

    expect(composeDownMock).toHaveBeenCalledWith(local, false);
  });

  it('refuses a lock for a stack nobody shares', async () => {
    const local = { ...sharedHost().host, sharedState: null } as unknown as ServerHost;

    await expect(stopStack(local, held.lease)).rejects.toThrow(/no lock to hold/);
    expect(composeDownMock).not.toHaveBeenCalled();
  });
});

describe('what a start makes sure of before it changes anything', () => {
  it('checks this Console can reach the stack before updating it for everyone', async () => {
    inspectStackMock.mockResolvedValue(present());
    const { host, checkNetworking } = sharedHost();
    const order: string[] = [];
    checkNetworking.mockImplementation(async () => void order.push('check ports'));
    assertManagedServerUrlFreeMock.mockImplementation(async () => void order.push('check address'));
    prepareUpgradeMock.mockImplementation(async () => {
      order.push('back up');
      return null;
    });
    composeUpMock.mockImplementation(async () => void order.push('compose up'));

    await startStack(startOptions(host));

    expect(checkNetworking).toHaveBeenCalledWith(hostPorts);
    expect(assertManagedServerUrlFreeMock).toHaveBeenCalledWith('http://localhost:41000', {
      kind: 'remote',
      sshHost: 'vm-1',
    });
    expect(order).toEqual(['check ports', 'check address', 'back up', 'compose up']);
  });

  it('changes nothing on the host when a port it needs is taken on this computer', async () => {
    inspectStackMock.mockResolvedValue(present());
    const { host, checkNetworking } = sharedHost();
    checkNetworking.mockRejectedValueOnce(
      new Error('Port 41000 is already in use on this computer')
    );

    await expect(startStack(startOptions(host))).rejects.toThrow(/41000 is already in use/);

    expect(prepareUpgradeMock).not.toHaveBeenCalled();
    expect(publishEnvMock).not.toHaveBeenCalled();
    expect(composeUpMock).not.toHaveBeenCalled();
  });

  it('changes nothing on the host when its address is already another server’s here', async () => {
    inspectStackMock.mockResolvedValue(present());
    assertManagedServerUrlFreeMock.mockRejectedValueOnce(
      new Error('http://localhost:41000 is already the address of “My local server”')
    );

    await expect(startStack(startOptions(sharedHost().host))).rejects.toThrow(
      /already the address/
    );

    expect(composeUpMock).not.toHaveBeenCalled();
    expect(publishEnvMock).not.toHaveBeenCalled();
  });
});

describe('recording which database this account’s settings are for', () => {
  it('stamps the .env it started the stack with, once compose has made the database', async () => {
    inspectStackMock.mockResolvedValue({ kind: 'absent' });
    const { host, writeFile } = sharedHost();

    const result = await startStack(startOptions(host));

    expect(result).toMatchObject({ kind: 'started', warning: null });
    expect(writeFile).toHaveBeenCalledWith('.env.db', '2026-09-01T10:00:00Z\n', 0o600);
    expect(composeUpMock.mock.invocationCallOrder[0]).toBeLessThan(
      currentDatabaseStampMock.mock.invocationCallOrder[0]!
    );
  });

  it('leaves no stamp to vouch for settings when the stack has no database to stamp', async () => {
    inspectStackMock.mockResolvedValue({ kind: 'absent' });
    currentDatabaseStampMock.mockResolvedValueOnce(null);
    const { host, removeFile } = sharedHost();

    await startStack(startOptions(host));

    expect(removeFile).toHaveBeenCalledWith('.env.db');
  });

  it('copies the published stamp with the published settings it brings into the working dir', async () => {
    inspectStackMock.mockResolvedValue(present({ stamp: '2026-09-02T11:00:00Z' }));
    const { host, writeFile } = sharedHost();

    await startStack(startOptions(host));

    expect(writeFile).toHaveBeenCalledWith('.env.db', '2026-09-02T11:00:00Z\n', 0o600);
  });

  it('drops the stamp with the rest of what a gone stack left behind', async () => {
    inspectStackMock.mockResolvedValue({ kind: 'absent' });
    const { host, removeFile } = sharedHost();

    await startStack(startOptions(host));

    expect(removeFile.mock.calls.slice(0, 2)).toEqual([['.env'], ['.env.db']]);
  });

  it('says so, without failing the start, when this account’s stamp cannot be written', async () => {
    inspectStackMock.mockResolvedValue({ kind: 'absent' });
    currentDatabaseStampMock.mockRejectedValueOnce(new Error('volume inspect timed out'));

    const result = await startStack(startOptions(sharedHost().host));

    expect(result.kind === 'started' && result.warning).toMatch(
      /could not be stamped with its database \(volume inspect timed out\)/
    );
  });
});
