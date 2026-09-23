import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import type { ServerHost } from './host/types';

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('@main/core/agents/resolve-servers', () => ({ resolveAgentServers: vi.fn() }));
vi.mock('@main/core/switch-servers/auth', () => ({ passwordLogin: vi.fn() }));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  ensureManagedServer: vi.fn(),
  setActiveServerId: vi.fn(),
}));
vi.mock('./secrets', () => ({ clearSecrets: vi.fn(), loadOrCreateSecrets: vi.fn() }));
vi.mock('./host/local-host', () => ({ restrictWindowsFileToOwner: vi.fn() }));
const { prepareLocalUpgrade, hasPendingLocalUpgrade, finishLocalUpgrade } =
  await import('./local-upgrade');
const { resetStack } = await import('./pipeline');
const { buildEnvFile } = await import('./env-file');
const { generateSecrets } = await import('./secret-values');
const { COMPATIBLE_SWITCH_VERSION } = await import('@shared/app-identity');
const exec = promisify(execFile);

// Explicit opt-in: real Docker, published old images, and a locally built candidate.
it.skipIf(process.env.SWITCH_UPGRADE_DOCKER_TEST !== '1')(
  'preserves an old room through backup, interrupted upgrade, migration and authenticated reconnect',
  async () => {
    const root = resolve(__dirname, '../../../../../../..');
    const scratch = await mkdtemp(join(tmpdir(), 'switch-upgrade-docker-'));
    const directory = join(scratch, 'not-created-yet');
    const project = `switch-upgrade-test-${randomUUID().slice(0, 8)}`;
    const image = process.env.SWITCH_UPGRADE_TEST_IMAGE ?? 'switch-upgrade-test:0.27.0';
    const secrets = generateSecrets();
    const composeFile = 'standalone-docker-compose.yml';
    const run = (command: string, args: string[], options = {}) =>
      exec(command, args, {
        cwd: directory,
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
        ...options,
      });
    const compose = (...args: string[]) =>
      run('docker', ['compose', '-p', project, '-f', composeFile, '--env-file', '.env', ...args]);
    const host = {
      kind: 'local',
      label: 'isolated Docker test',
      workingDir: directory,
      stateDir: directory,
      teardownNetworking: async () => {},
      composeProjectName: project,
      dockerBin: 'docker',
      ctx: { exec: run },
      readFile: (name: string) =>
        readFile(join(directory, name), 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        }),
      writeFile: async (name: string, value: string, mode?: number) => {
        await mkdir(dirname(join(directory, name)), { recursive: true });
        await writeFile(join(directory, name), value, { mode });
      },
    } as unknown as ServerHost;
    const env = buildEnvFile({
      version: COMPATIBLE_SWITCH_VERSION,
      registry: 'ghcr.io',
      namespace: 'sandbox-quantum',
      ports: { api: 0, gateway: 0, postgres: 0, mattermost: 0 },
      secrets,
    });
    const oldEnv = env
      .replace(`SWITCH_VERSION=${COMPATIBLE_SWITCH_VERSION}`, 'SWITCH_VERSION=0.25.0')
      .replace('DB_USER=switch_app', 'DB_USER=postgres')
      .replace(`DB_PASSWORD=${secrets.dbRuntimePassword}`, `DB_PASSWORD=${secrets.dbPassword}`);
    const api = async (action: string) => {
      const { stdout } = await compose(
        'exec',
        '-T',
        'switch',
        'python',
        '-c',
        `
import json, os, urllib.request, urllib.error
base = 'http://127.0.0.1:8000/gateway'
data = json.dumps({'email': os.environ['GATEWAY_ADMIN_EMAIL'], 'password': os.environ['GATEWAY_ADMIN_PASSWORD']}).encode()
r = urllib.request.urlopen(urllib.request.Request(base + '/auth/login', data=data, headers={'Content-Type': 'application/json'}), timeout=10)
user = json.load(r)
cookie = r.headers['Set-Cookie'].split(';')[0]
def request(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, headers={'Cookie': cookie, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error
${action}
`
      );
      return JSON.parse(stdout.trim());
    };
    const waitForLogin = async () => {
      await expect
        .poll(() => api('print(json.dumps(user))'), { timeout: 120_000, interval: 2000 })
        .toBeTruthy();
      return api('print(json.dumps(user))');
    };
    try {
      await exec('docker', ['image', 'inspect', image]);
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      await prepareLocalUpgrade(host, null, () => {});
      expect(await hasPendingLocalUpgrade(host)).toBe(false);
      const old = await exec(
        'git',
        ['show', 'switch-v0.25.0:deploy/local/standalone-docker-compose.yml'],
        { cwd: root }
      );
      await host.writeFile(composeFile, old.stdout);
      await host.writeFile('.env', oldEnv, 0o600);
      await compose('up', '-d', 'switch');
      const before = await waitForLogin();
      expect(before.server.version).toBe('0.25.0');
      expect(before.server.contracts['sdk-sessions']).toBeUndefined();
      await api(
        "request('/agents/register-other', {'name': 'upgrade-test-agent', 'description': 'Upgrade test agent'}); print('{}')"
      );
      const room = await api(
        "print(json.dumps(request('/rooms', {'name': 'upgrade-preserved-room', 'description': 'Created before the SDK upgrade', 'internal_only': True, 'agent_names': ['upgrade-test-agent']})))"
      );
      await prepareLocalUpgrade(host, null, () => {});
      const journal = JSON.parse((await host.readFile('upgrade.json'))!);
      expect(journal).toMatchObject({ from: '0.25.0', to: COMPATIBLE_SWITCH_VERSION });
      const dump = join(journal.backup, 'database.sql');
      expect(await readFile(dump, 'utf8')).toContain('upgrade-preserved-room');
      if (process.platform !== 'win32') expect((await stat(dump)).mode & 0o777).toBe(0o600);
      expect(await readFile(join(journal.backup, '.env'), 'utf8')).toBe(oldEnv);
      // Simulate interruption after rewriting configuration but before Compose succeeds.
      await host.writeFile(
        composeFile,
        await readFile(join(root, 'deploy/local/standalone-docker-compose.yml'), 'utf8')
      );
      await host.writeFile('.env', env, 0o600);
      await prepareLocalUpgrade(host, null, () => {});
      expect(JSON.parse((await host.readFile('upgrade.json'))!).backup).toBe(journal.backup);
      await host.writeFile(
        'candidate.yml',
        `services:\n  switch:\n    image: ${JSON.stringify(image)}\n    pull_policy: never\n`
      );
      await run('docker', [
        'compose',
        '-p',
        project,
        '-f',
        composeFile,
        '-f',
        'candidate.yml',
        '--env-file',
        '.env',
        'up',
        '-d',
        'switch',
      ]);
      const after = await waitForLogin();
      expect(after.server.version).toBe(COMPATIBLE_SWITCH_VERSION);
      expect(after.server.contracts['sdk-sessions']).toEqual({ speaks: 1, accepts: 1 });
      const restored = await api(`print(json.dumps(request('/rooms/${room.id}')))`);
      expect(restored).toMatchObject({
        id: room.id,
        name: 'upgrade-preserved-room',
        description: 'Created before the SDK upgrade',
      });
      expect(await hasPendingLocalUpgrade(host)).toBe(true);
      await finishLocalUpgrade(host);
      expect(await hasPendingLocalUpgrade(host)).toBe(false);
      expect(await readFile(dump, 'utf8')).toContain('upgrade-preserved-room');

      // Reset an older, stopped stack, then bootstrap with fresh credentials.
      await compose('down', '--volumes', '--remove-orphans');
      await host.writeFile(composeFile, old.stdout);
      await host.writeFile('.env', oldEnv, 0o600);
      await compose('up', '-d', '--wait', 'postgres');
      await compose('stop');
      await resetStack(host);
      expect(await host.readFile('.env')).toBeNull();
      await prepareLocalUpgrade(host, null, () => {});
      expect(await hasPendingLocalUpgrade(host)).toBe(false);
      const freshSecrets = generateSecrets();
      expect(freshSecrets.dbPassword).not.toBe(secrets.dbPassword);
      await host.writeFile(
        composeFile,
        await readFile(join(root, 'deploy/local/standalone-docker-compose.yml'), 'utf8')
      );
      await host.writeFile(
        '.env',
        buildEnvFile({
          version: COMPATIBLE_SWITCH_VERSION,
          registry: 'ghcr.io',
          namespace: 'sandbox-quantum',
          ports: { api: 0, gateway: 0, postgres: 0, mattermost: 0 },
          secrets: freshSecrets,
        }),
        0o600
      );
      await run('docker', [
        'compose',
        '-p',
        project,
        '-f',
        composeFile,
        '-f',
        'candidate.yml',
        '--env-file',
        '.env',
        'up',
        '-d',
        'switch',
      ]);
      expect((await waitForLogin()).server.version).toBe(COMPATIBLE_SWITCH_VERSION);
      expect(await readFile(dump, 'utf8')).toContain('upgrade-preserved-room');
    } finally {
      // Only this random project's disposable volumes are removed.
      try {
        await compose('down', '--volumes', '--remove-orphans');
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
  },
  600_000
);
