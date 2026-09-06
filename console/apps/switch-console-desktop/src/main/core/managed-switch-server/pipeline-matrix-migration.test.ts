/**
 * The upgrade that removes the message server must copy its history first.
 *
 * Two properties, and the second is the one that protects the data: the copy
 * runs against the stack as it is currently deployed — before anything is
 * rewritten, because the rewrite is what takes the homeserver away — and a
 * copy that fails stops the upgrade rather than being logged and stepped over.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppIdentity from '@shared/app-identity';
import type * as DeployedVersion from './deployed-version';
import type { ServerHost } from './host/types';

const readDeployedVersionMock = vi.hoisted(() => vi.fn());
const composeUpMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const dockerRunOneOffMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('@shared/app-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof AppIdentity>()),
  COMPATIBLE_SWITCH_VERSION: '0.24.0',
  LAST_MATRIX_VERSION: '0.23.0',
}));
vi.mock('@main/lib/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('./deployed-version', async (importOriginal) => ({
  ...(await importOriginal<typeof DeployedVersion>()),
  readDeployedVersion: readDeployedVersionMock,
}));
vi.mock('./compose', () => ({
  composeUp: composeUpMock,
  dockerRunOneOff: dockerRunOneOffMock,
  composeDown: vi.fn(() => Promise.resolve()),
  runningImages: vi.fn(),
  isStackRunning: vi.fn(),
}));
vi.mock('./health', () => ({ waitForHealth: () => Promise.resolve(true) }));
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
vi.mock('./env-file', () => ({ buildEnvFile: () => 'SWITCH_VERSION=0.24.0\n' }));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  ensureManagedServer: () => Promise.resolve({ id: 'srv-1' }),
  setActiveServerId: vi.fn(),
}));
vi.mock('@main/core/switch-servers/auth', () => ({
  passwordLogin: () => Promise.resolve({ success: true }),
}));
vi.mock('@main/core/agents/resolve-servers', () => ({ resolveAgentServers: vi.fn() }));

const { startStack } = await import('./pipeline');

function options(checkoutRoot: string | null = null) {
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
      checkoutRoot,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('startStack across the Matrix boundary', () => {
  it('copies the history before rewriting anything', async () => {
    readDeployedVersionMock.mockResolvedValue({
      kind: 'deployed',
      version: '0.23.0',
      source: 'container',
    });
    const { opts, writeFile } = options();
    const order: string[] = [];
    composeUpMock.mockImplementation(() => {
      order.push('compose-up');
      return Promise.resolve();
    });
    dockerRunOneOffMock.mockImplementation(() => {
      order.push('backfill');
      return Promise.resolve();
    });
    writeFile.mockImplementation(() => {
      order.push('write');
      return Promise.resolve();
    });

    expect(await startStack(opts)).toEqual({ kind: 'started', serverId: 'srv-1' });
    // The old stack comes up and is drained before the new compose file lands:
    // that file is what removes the homeserver being read from.
    expect(order.slice(0, 3)).toEqual(['compose-up', 'backfill', 'write']);
    // Pinned to the boundary image, not to whatever the stack is running: the
    // install that needs this most is the one whose own images have no backfill.
    expect(dockerRunOneOffMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        image: 'ghcr.io/sandbox-quantum/switch-core:0.23.0',
        command: ['python', '-m', 'switch_core.cli.backfill', '--allow-empty'],
      }),
      expect.anything()
    );
  });

  it('refuses the upgrade when the copy fails, leaving the stack as it was', async () => {
    readDeployedVersionMock.mockResolvedValue({
      kind: 'deployed',
      version: '0.22.1',
      source: 'container',
    });
    dockerRunOneOffMock.mockRejectedValue(new Error('homeserver unreachable'));
    const { opts, writeFile } = options();

    const result = await startStack(opts);

    expect(result).toMatchObject({
      kind: 'matrix-migration-failed',
      deployed: '0.22.1',
      expected: '0.24.0',
    });
    // Nothing rewritten, so the stack is still the one that can be retried.
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('does not copy when the stack is already past the boundary', async () => {
    readDeployedVersionMock.mockResolvedValue({
      kind: 'deployed',
      version: '0.24.0',
      source: 'container',
    });
    const { opts } = options();

    expect(await startStack(opts)).toEqual({ kind: 'started', serverId: 'srv-1' });
    expect(dockerRunOneOffMock).not.toHaveBeenCalled();
  });

  it('does not copy for a checkout build', async () => {
    // Built from a working tree, so it carries no comparable version — and its
    // data is a developer's, not somebody's install.
    readDeployedVersionMock.mockResolvedValue({
      kind: 'deployed',
      version: '0.22.1',
      source: 'container',
    });
    const { opts } = options('/src/switch');

    await startStack(opts);
    expect(dockerRunOneOffMock).not.toHaveBeenCalled();
  });
});
