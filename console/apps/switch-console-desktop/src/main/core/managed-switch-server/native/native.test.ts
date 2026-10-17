import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readLocalRuntime, writeLocalRuntime } from '../runtime';
import { generateSecrets } from '../secret-values';
import { buildNativeCoreSettings } from './core-settings';
import { downloadFile } from './download';
import { mattermostCallbackBaseUrl, mattermostComposeYaml, mattermostImage } from './mattermost';
import { nativeLayout } from './native-paths';
import { parsePostgresMajor, resolvePostgres } from './postgres-binaries';
import { currentNativePlatform, postgresArchive, uvArchive } from './toolchain-pins';
import { parseUvVersion } from './uv';

vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('buildNativeCoreSettings', () => {
  const secrets = generateSecrets();
  const settings = buildNativeCoreSettings({
    apiPort: 51001,
    postgresPort: 51002,
    callbackPort: 51003,
    secrets,
    telemetryEnabled: false,
    telemetryEnvironment: 'local',
    telemetryInternal: false,
  });

  it('holds every listener to loopback', () => {
    expect(settings.SERVER_HOST).toBe('127.0.0.1');
    expect(settings.COLLABORATION_CALLBACK_HOST).toBe('127.0.0.1');
    expect(settings.COLLABORATION_CALLBACK_PORT).toBe('51003');
  });

  it('serves as the restricted role and migrates as the owner', () => {
    expect(settings).toMatchObject({
      DB_HOST: '127.0.0.1',
      DB_PORT: '51002',
      DB_USER: 'switch_app',
      DB_PASSWORD: secrets.dbRuntimePassword,
      DB_OWNER_USER: 'postgres',
      DB_OWNER_PASSWORD: secrets.dbPassword,
      DB_NAME: 'switch',
    });
  });

  it('points every public URL at switch-core, which serves the gateway too', () => {
    expect(settings.FRONTEND_BASE_URL).toBe('http://localhost:51001');
    expect(settings.GATEWAY_PUBLIC_URL).toBe('http://localhost:51001');
  });

  it('says "no" to telemetry explicitly rather than by omission', () => {
    expect(settings.TELEMETRY_ENABLED).toBe('false');
  });
});

describe('mattermost', () => {
  it('runs the image the bundled compose pins', () => {
    expect(mattermostImage()).toMatch(/^mattermost\/mattermost-team-edition:\d+\.\d+\.\d+$/);
  });

  it('shares the host network on Linux and listens on loopback only', () => {
    const yaml = mattermostComposeYaml({
      platform: 'linux',
      mattermostPort: 8065,
      postgresPort: 5432,
      ownerPassword: 'pw',
    });
    expect(yaml).toContain('network_mode: host');
    expect(yaml).toContain('MM_SERVICESETTINGS_LISTENADDRESS: "127.0.0.1:8065"');
    expect(yaml).toContain('@127.0.0.1:5432/mattermost');
    expect(yaml).not.toContain('ports:');
  });

  it('reaches the host through host.docker.internal on Docker Desktop', () => {
    const yaml = mattermostComposeYaml({
      platform: 'darwin',
      mattermostPort: 8065,
      postgresPort: 5432,
      ownerPassword: 'pw',
    });
    expect(yaml).toContain('"127.0.0.1:8065:8065"');
    expect(yaml).toContain('@host.docker.internal:5432/mattermost');
    expect(yaml).not.toContain('network_mode');
    expect(mattermostCallbackBaseUrl('darwin', 51003)).toBe('http://host.docker.internal:51003');
    expect(mattermostCallbackBaseUrl('linux', 51003)).toBe('http://127.0.0.1:51003');
  });
});

describe('version parsing', () => {
  it('reads the major from postgres --version', () => {
    expect(parsePostgresMajor('postgres (PostgreSQL) 16.14')).toBe(16);
    expect(parsePostgresMajor('postgres (PostgreSQL) 17.2 (Homebrew)')).toBe(17);
    expect(parsePostgresMajor('something else')).toBeNull();
  });

  it('reads uv --version', () => {
    expect(parseUvVersion('uv 0.13.1 (x86_64-unknown-linux-gnu)')).toBe('0.13.1');
    expect(parseUvVersion('uv 0.5.0')).toBe('0.5.0');
    expect(parseUvVersion('nope')).toBeNull();
  });
});

describe('toolchain pins', () => {
  it('knows the platforms Console ships on', () => {
    expect(currentNativePlatform('darwin', 'arm64')).toBe('darwin-arm64');
    expect(currentNativePlatform('win32', 'x64')).toBe('win32-x64');
    expect(currentNativePlatform('freebsd', 'x64')).toBeNull();
  });

  it('has a checksum for every download', () => {
    for (const platform of ['darwin-arm64', 'linux-x64', 'win32-x64'] as const) {
      expect(uvArchive(platform).integrity).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(postgresArchive(platform)?.integrity).toMatch(/^sha512-/);
    }
    // No portable PostgreSQL is published for Windows on Arm.
    expect(postgresArchive('win32-arm64')).toBeNull();
  });
});

describe('downloadFile', () => {
  const body = Buffer.from('the archive');
  let server: Server;
  let url = '';
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'switch-download-'));
    server = createServer((_req, res) => res.end(body));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`;
  });
  afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps a download whose checksum matches', async () => {
    const sha256 = createHash('sha256').update(body).digest('hex');
    const file = path.join(dir, 'ok');
    await downloadFile(url, file, `sha256:${sha256}`);
    expect(await readFile(file)).toEqual(body);
  });

  it('refuses one that does not, and leaves nothing behind', async () => {
    const file = path.join(dir, 'bad');
    await expect(downloadFile(url, file, `sha256:${'0'.repeat(64)}`)).rejects.toThrow(
      'does not match its pinned checksum'
    );
    await expect(readFile(file)).rejects.toThrow();
    await expect(readFile(`${file}.partial`)).rejects.toThrow();
  });
});

describe('readLocalRuntime', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'switch-runtime-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is native for a new install', async () => {
    expect(await readLocalRuntime(path.join(dir, 'fresh'))).toBe('native');
  });

  it('keeps a server set up on Docker on Docker', async () => {
    const legacy = path.join(dir, 'legacy');
    await writeLocalRuntime(legacy, 'native');
    await rm(path.join(legacy, 'runtime.json'));
    await writeFile(path.join(legacy, 'standalone-docker-compose.yml'), 'services: {}\n');
    expect(await readLocalRuntime(legacy)).toBe('docker');
  });

  it('follows what was recorded', async () => {
    const recorded = path.join(dir, 'recorded');
    await writeFile(path.join(dir, 'placeholder'), '');
    await writeLocalRuntime(recorded, 'native');
    await writeFile(path.join(recorded, '.env'), 'SWITCH_VERSION=0.1.0\n');
    expect(await readLocalRuntime(recorded)).toBe('native');
  });
});

describe('resolvePostgres', () => {
  it('refuses a database created by a PostgreSQL older than switch-core supports', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'switch-pg14-'));
    try {
      const layout = nativeLayout(root);
      await mkdir(layout.pgdata, { recursive: true });
      await writeFile(path.join(layout.pgdata, 'PG_VERSION'), '14\n');
      await expect(resolvePostgres(layout, null, () => {})).rejects.toThrow(
        'created by PostgreSQL 14, and switch-core needs PostgreSQL 16 or newer. Reset the server'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
