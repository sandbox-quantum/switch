import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppIdentity from '@shared/app-identity';
import type * as DeployedVersion from './deployed-version';
import type { ServerHost } from './host/types';

/**
 * Covers the downgrade guard only (CHOO-1736). The rest of `startStack` is an
 * orchestration of already-tested pieces; what matters here is that a stack
 * ahead of this build is refused BEFORE anything on the host is touched.
 */

const readDeployedVersionMock = vi.hoisted(() => vi.fn());
const composeUpMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const waitForHealthMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const logError = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());

// Pin the build's expected version so the guard's arithmetic is not coupled to
// whatever the real pin happens to be.
vi.mock('@shared/app-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof AppIdentity>()),
  COMPATIBLE_SWITCH_VERSION: '0.11.0',
}));
vi.mock('@main/lib/logger', () => ({
  log: { error: logError, warn: logWarn, info: vi.fn() },
}));
vi.mock('./deployed-version', async (importOriginal) => ({
  ...(await importOriginal<typeof DeployedVersion>()),
  readDeployedVersion: readDeployedVersionMock,
}));
vi.mock('./compose', () => ({
  composeUp: composeUpMock,
  composeDown: vi.fn(() => Promise.resolve()),
  runningImages: vi.fn(),
  isStackRunning: vi.fn(),
}));
vi.mock('./health', () => ({ waitForHealth: waitForHealthMock }));
vi.mock('./bundled-compose', () => ({ bundledComposeYaml: () => 'services: {}' }));
vi.mock('./secrets', () => ({
  loadOrCreateSecrets: () => Promise.resolve({ gatewayAdminPassword: 'pw' }),
  clearSecrets: vi.fn(),
}));
vi.mock('./ports', () => ({
  resolvePorts: () =>
    Promise.resolve({ gateway: 3300, api: 8000, mattermost: 8065, postgres: 5432 }),
  clearPorts: vi.fn(),
}));
vi.mock('./env-file', () => ({ buildEnvFile: () => 'SWITCH_VERSION=0.11.0\n' }));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  ensureManagedServer: () => Promise.resolve({ id: 'srv-1' }),
  setActiveServerId: vi.fn(),
}));
vi.mock('@main/core/switch-servers/auth', () => ({
  passwordLogin: () => Promise.resolve({ success: true }),
}));
vi.mock('@main/core/agents/resolve-servers', () => ({ resolveAgentServers: vi.fn() }));

const { startStack, resetStack } = await import('./pipeline');
const { ENV_FILE_NAME } = await import('./constants');

function options() {
  const writeFile = vi.fn<(relPath: string, content: string, mode?: number) => Promise<void>>(() =>
    Promise.resolve()
  );
  const host = {
    label: 'this computer',
    writeFile,
    detectDocker: () => Promise.resolve({ available: true, version: '27.0.0' }),
    establishNetworking: vi.fn(() => Promise.resolve()),
  };
  return {
    writeFile,
    opts: {
      host: host as unknown as ServerHost,
      ref: { kind: 'local' as const },
      serverName: 'Local',
      onMessage: vi.fn(),
      onLog: vi.fn(),
      signal: new AbortController().signal,
      checkoutRoot: null as string | null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('startStack version guard', () => {
  it('refuses to start a stack that is ahead of this build', async () => {
    readDeployedVersionMock.mockResolvedValue({
      kind: 'deployed',
      version: '0.12.0',
      source: 'container',
    });
    const { opts, writeFile } = options();

    expect(await startStack(opts)).toEqual({
      kind: 'version-downgrade',
      deployed: '0.12.0',
      expected: '0.11.0',
    });
    // Nothing on the host may be touched: the existing `.env` still names the
    // version the stack was last started with, so the refusal is recoverable
    // just by reinstalling the newer Switch Console.
    expect(writeFile).not.toHaveBeenCalled();
    expect(composeUpMock).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledOnce();
  });

  it('starts a stack that is behind this build, rewriting the .env', async () => {
    readDeployedVersionMock.mockResolvedValue({
      kind: 'deployed',
      version: '0.3.0',
      source: 'container',
    });
    const { opts, writeFile } = options();

    expect(await startStack(opts)).toEqual({ kind: 'started', serverId: 'srv-1' });
    expect(writeFile).toHaveBeenCalledWith(ENV_FILE_NAME, expect.any(String), 0o600);
    expect(composeUpMock).toHaveBeenCalledOnce();
  });

  it('starts a fresh host with nothing deployed', async () => {
    readDeployedVersionMock.mockResolvedValue({ kind: 'absent' });
    const { opts } = options();
    expect(await startStack(opts)).toEqual({ kind: 'started', serverId: 'srv-1' });
  });

  it('starts a matching stack (the plain restart path)', async () => {
    readDeployedVersionMock.mockResolvedValue({
      kind: 'deployed',
      version: '0.11.0',
      source: 'container',
    });
    const { opts } = options();
    expect(await startStack(opts)).toEqual({ kind: 'started', serverId: 'srv-1' });
  });

  it('proceeds with a warning when the deployed version cannot be read', async () => {
    readDeployedVersionMock.mockResolvedValue({ kind: 'unreadable', reason: 'daemon down' });
    const { opts } = options();

    expect(await startStack(opts)).toEqual({ kind: 'started', serverId: 'srv-1' });
    // Degraded, but disclosed — a transient probe failure must not make the app
    // unstartable.
    expect(logWarn).toHaveBeenCalledOnce();
  });

  it('allows a version it cannot compare, since a downgrade is not proven', async () => {
    readDeployedVersionMock.mockResolvedValue({
      kind: 'deployed',
      version: 'nightly',
      source: 'container',
    });
    const { opts } = options();
    expect(await startStack(opts)).toEqual({ kind: 'started', serverId: 'srv-1' });
  });

  it('says so loudly when it cannot prove the start is not a downgrade', async () => {
    // An uncomparable pair used to fall into the same "not a downgrade" branch
    // as a clean match and pass in complete silence (CHOO-1865). It carries the
    // same risk as a downgrade; we simply cannot prove it, and the log has to
    // make that difference visible to whoever reads it afterwards.
    readDeployedVersionMock.mockResolvedValue({
      kind: 'deployed',
      version: 'nightly',
      source: 'container',
    });
    const { opts } = options();
    await startStack(opts);

    expect(logError).toHaveBeenCalledOnce();
    expect(logError.mock.calls[0]?.[0]).toContain('not comparable');
  });

  it('stays silent when the versions match, so the log means something', async () => {
    readDeployedVersionMock.mockResolvedValue({
      kind: 'deployed',
      version: '0.11.0',
      source: 'container',
    });
    const { opts } = options();
    await startStack(opts);

    expect(logError).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('refuses before writing configuration, so nothing off-host happens either', async () => {
    readDeployedVersionMock.mockResolvedValue({
      kind: 'deployed',
      version: '0.12.0',
      source: 'env-file',
    });
    const { writeFile, opts } = options();
    await startStack(opts);
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe('startStack checkout build', () => {
  /** The whole point of the dev mode: the images must come from the working
   * tree, and must not be tagged as if they were the pinned release. */
  it('writes the build override, tags the images apart, and builds', async () => {
    readDeployedVersionMock.mockResolvedValue({ kind: 'absent' });
    const { opts, writeFile } = options();
    opts.checkoutRoot = '/src/switch';

    expect(await startStack(opts)).toEqual({ kind: 'started', serverId: 'srv-1' });

    const override = writeFile.mock.calls.find(
      ([name]) => name === 'standalone-docker-compose.build.yml'
    );
    expect(override?.[1]).toContain('/src/switch');
    expect(composeUpMock).toHaveBeenCalledWith(expect.anything(), expect.any(Function), true);
  });

  it('skips the downgrade guard, saying so, rather than refusing the start', async () => {
    readDeployedVersionMock.mockResolvedValue({
      kind: 'deployed',
      version: '0.12.0',
      source: 'container',
    });
    const { opts } = options();
    opts.checkoutRoot = '/src/switch';

    expect(await startStack(opts)).toEqual({ kind: 'started', serverId: 'srv-1' });
    expect(logWarn).toHaveBeenCalled();
  });

  it('leaves the released path unbuilt and without an override', async () => {
    readDeployedVersionMock.mockResolvedValue({ kind: 'absent' });
    const { opts, writeFile } = options();

    await startStack(opts);

    expect(
      writeFile.mock.calls.some(([name]) => name === 'standalone-docker-compose.build.yml')
    ).toBe(false);
    expect(composeUpMock).toHaveBeenCalledWith(expect.anything(), expect.any(Function), false);
  });
});

describe('local reset configuration', () => {
  it.each([false, true])(
    'clears old credentials only after volumes are removed (failure=%s)',
    async (failure) => {
      const directory = await mkdtemp(join(tmpdir(), 'switch-reset-test-'));
      const { composeDown } = await import('./compose');
      const { clearSecrets } = await import('./secrets');
      const host = {
        kind: 'local',
        workingDir: directory,
        teardownNetworking: vi.fn(),
      } as unknown as ServerHost;
      await writeFile(join(directory, ENV_FILE_NAME), 'SWITCH_VERSION=0.25.0');
      vi.mocked(clearSecrets).mockClear();
      vi.mocked(clearSecrets).mockImplementationOnce(async () => {
        await expect(readFile(join(directory, ENV_FILE_NAME))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      });
      if (failure) vi.mocked(composeDown).mockRejectedValueOnce(new Error('volume removal failed'));
      try {
        if (failure) {
          await expect(resetStack(host)).rejects.toThrow('volume removal failed');
          expect(await readFile(join(directory, ENV_FILE_NAME), 'utf8')).toContain('0.25.0');
          expect(clearSecrets).not.toHaveBeenCalled();
        } else {
          await resetStack(host);
          expect(clearSecrets).toHaveBeenCalledOnce();
          await expect(readFile(join(directory, ENV_FILE_NAME))).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
      } finally {
        vi.mocked(clearSecrets).mockReset();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
