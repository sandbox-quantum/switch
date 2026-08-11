import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerHost } from './host/types';

const runningImagesMock = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('./compose', () => ({ runningImages: runningImagesMock }));
vi.mock('@main/lib/logger', () => ({ log: { warn, info: vi.fn(), error: vi.fn() } }));

const { classifyVersionDrift, readDeployedVersion, readVersionStatus } =
  await import('./deployed-version');
const { ENV_FILE_NAME } = await import('./constants');

type FakeHostOptions = {
  images?: Map<string, string>;
  imagesError?: Error;
  env?: string | null;
  envError?: Error;
};

/** Minimal {@link ServerHost} — `readDeployedVersion` only ever touches
 * `readFile` and (through the mocked compose module) the host identity. */
function fakeHost(opts: FakeHostOptions) {
  runningImagesMock.mockImplementation(() => {
    if (opts.imagesError) return Promise.reject(opts.imagesError);
    return Promise.resolve(opts.images ?? new Map());
  });
  return {
    label: 'test host',
    readFile: vi.fn((relPath: string) => {
      expect(relPath).toBe(ENV_FILE_NAME);
      if (opts.envError) return Promise.reject(opts.envError);
      return Promise.resolve(opts.env ?? null);
    }),
  } as unknown as ServerHost & { readFile: ReturnType<typeof vi.fn> };
}

const coreImage = (tag: string) =>
  new Map([['switch', `ghcr.io/sandbox-quantum/switch-core:${tag}`]]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readDeployedVersion', () => {
  it('prefers the running core container tag', async () => {
    const host = fakeHost({ images: coreImage('0.11.0'), env: 'SWITCH_VERSION=0.3.0\n' });
    expect(await readDeployedVersion(host)).toEqual({
      kind: 'deployed',
      version: '0.11.0',
      source: 'container',
    });
    // The `.env` is only a fallback — the container tag settled it.
    expect(host.readFile).not.toHaveBeenCalled();
  });

  it('falls back to the .env when the stack is stopped', async () => {
    const host = fakeHost({
      images: new Map(),
      env: 'POSTGRES_PASSWORD=x\nSWITCH_VERSION=0.9.1\nSWITCH_BIND_ADDR=127.0.0.1\n',
    });
    expect(await readDeployedVersion(host)).toEqual({
      kind: 'deployed',
      version: '0.9.1',
      source: 'env-file',
    });
  });

  it('reports absent when nothing was ever deployed', async () => {
    expect(await readDeployedVersion(fakeHost({ images: new Map(), env: null }))).toEqual({
      kind: 'absent',
    });
  });

  it('reports unreadable — not absent — when the daemon cannot be asked and there is no .env', async () => {
    const result = await readDeployedVersion(
      fakeHost({ imagesError: new Error('docker daemon not running'), env: null })
    );
    expect(result.kind).toBe('unreadable');
    expect(result).toMatchObject({ reason: expect.stringContaining('docker daemon not running') });
  });

  it('still uses the .env when the daemon cannot be asked', async () => {
    const host = fakeHost({
      imagesError: new Error('connection refused'),
      env: 'SWITCH_VERSION=0.7.2\n',
    });
    expect(await readDeployedVersion(host)).toEqual({
      kind: 'deployed',
      version: '0.7.2',
      source: 'env-file',
    });
  });

  it('reports unreadable when the .env carries no version', async () => {
    const result = await readDeployedVersion(
      fakeHost({ images: new Map(), env: 'POSTGRES_PASSWORD=x\n' })
    );
    expect(result.kind).toBe('unreadable');
  });

  it('ignores a digest-pinned image and an untagged one', async () => {
    const digest = new Map([['switch', 'ghcr.io/sandbox-quantum/switch-core@sha256:abc123']]);
    expect(await readDeployedVersion(fakeHost({ images: digest, env: null }))).toEqual({
      kind: 'absent',
    });
    const untagged = new Map([['switch', 'ghcr.io/sandbox-quantum/switch-core']]);
    expect(await readDeployedVersion(fakeHost({ images: untagged, env: null }))).toEqual({
      kind: 'absent',
    });
  });

  it('is not confused by a registry port in the image reference', async () => {
    const images = new Map([['switch', 'localhost:5000/sandbox-quantum/switch-core:1.4.0']]);
    expect(await readDeployedVersion(fakeHost({ images, env: null }))).toMatchObject({
      version: '1.4.0',
    });
  });

  it('reads the core service, not another service that happens to be up', async () => {
    const images = new Map([
      ['gateway', 'ghcr.io/sandbox-quantum/gateway:0.11.0'],
      ['postgres', 'postgres:16-alpine'],
    ]);
    expect(await readDeployedVersion(fakeHost({ images, env: null }))).toEqual({ kind: 'absent' });
  });

  it('unquotes a quoted .env value', async () => {
    const host = fakeHost({ images: new Map(), env: 'SWITCH_VERSION="0.5.0"\n' });
    expect(await readDeployedVersion(host)).toMatchObject({ version: '0.5.0' });
  });
});

describe('classifyVersionDrift', () => {
  it('is null when the versions match', () => {
    expect(classifyVersionDrift('0.11.0', '0.11.0')).toBeNull();
    expect(classifyVersionDrift('v0.11.0', '0.11.0')).toBeNull();
  });

  it('calls a behind stack an upgrade', () => {
    expect(classifyVersionDrift('0.3.0', '0.11.0')).toEqual({
      deployed: '0.3.0',
      expected: '0.11.0',
      direction: 'upgrade',
    });
  });

  it('calls an ahead stack a downgrade', () => {
    expect(classifyVersionDrift('0.12.0', '0.11.0')).toEqual({
      deployed: '0.12.0',
      expected: '0.11.0',
      direction: 'downgrade',
    });
  });

  it('surfaces an uncomparable pair rather than assuming it is safe', () => {
    expect(classifyVersionDrift('nightly', '0.11.0')).toEqual({
      deployed: 'nightly',
      expected: '0.11.0',
      direction: 'unknown',
    });
  });
});

describe('readVersionStatus', () => {
  it('reports the deployed version and its drift', async () => {
    const host = fakeHost({ images: coreImage('0.3.0'), env: null });
    expect(await readVersionStatus(host, '0.11.0')).toEqual({
      deployedVersion: '0.3.0',
      drift: { deployed: '0.3.0', expected: '0.11.0', direction: 'upgrade' },
    });
  });

  it('reports no drift for a matching stack', async () => {
    const host = fakeHost({ images: coreImage('0.11.0'), env: null });
    expect(await readVersionStatus(host, '0.11.0')).toEqual({
      deployedVersion: '0.11.0',
      drift: null,
    });
  });

  it('reports an unreadable host as unreadable, not as no drift', async () => {
    // It used to return drift: null — the same answer a healthy, in-step stack
    // gives — so a failed probe rendered as fine and the user was told nothing
    // (CHOO-1865). Unknown must never look like fine.
    const host = fakeHost({ imagesError: new Error('ssh: connection closed'), env: null });
    expect(await readVersionStatus(host, '0.11.0')).toEqual({
      deployedVersion: null,
      drift: {
        deployed: null,
        expected: '0.11.0',
        direction: 'unreadable',
        reason: expect.stringContaining('ssh: connection closed'),
      },
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('reports nothing for a host with no stack', async () => {
    // `absent` is genuinely not a drift: nothing has been deployed here, which
    // is a first start rather than a failed check.
    const host = fakeHost({ images: new Map(), env: null });
    expect(await readVersionStatus(host, '0.11.0')).toEqual({
      deployedVersion: null,
      drift: null,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
