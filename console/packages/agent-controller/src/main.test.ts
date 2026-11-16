import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as doctor from './doctor';
import { EXIT_CONFIGURATION, EXIT_FAILURE, EXIT_OK } from './exit-codes';
import { infoChange, installerFor, isSupervised, main, planServiceReleases, VERSION } from './main';
import { dataLayout } from './paths';
import { assignmentSchema } from './schemas';
import { CONTROLLER_CREDENTIAL, FileSecretStore } from './secrets';
import { ReleasesDirInstaller } from './self-update';
import * as separateUsers from './separate-users';
import * as service from './service';
import { ControllerStore } from './store';
import * as update from './update';

let dir: string;
let bundle: string;
let stderr: string[];
let stdout: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-main-'));
  bundle = join(dir, 'shared-host.mjs');
  writeFileSync(bundle, '');
  stderr = [];
  stdout = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** The last line the CLI wrote to stderr: the reason a parent shows. */
function lastLine(): string {
  return stderr.join('').trimEnd().split('\n').at(-1) ?? '';
}

describe('main', () => {
  it('exits 2 for arguments it cannot run with, and says why last', async () => {
    expect(await main(['launch'])).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toBe("switch-agent-controller: Unknown command 'launch'.");
    expect(await main(['run', '--no-such-flag'])).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toMatch(/^switch-agent-controller: Unknown option '--no-such-flag'/);
    expect(await main(['run', '--controller-id', 'controller-1'])).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toBe(
      'switch-agent-controller: --controller-id and --server adopt an identity together; pass both.'
    );
    expect(await main(['run', '--updated-by-console', '--releases-dir', '/tmp/releases'])).toBe(
      EXIT_CONFIGURATION
    );
    expect(lastLine()).toMatch(/--updated-by-console and --releases-dir disagree/);
    expect(await main(['enroll', '--server', 'https://switch.example.com'])).toBe(
      EXIT_CONFIGURATION
    );
    expect(await main([])).toBe(EXIT_CONFIGURATION);
    expect(await main(['--help'])).toBe(EXIT_OK);
  });

  it('enrolls with the name and description it is given', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({ controller_id: 'controller-1', credential: 'swcc_test' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    const code = await main([
      'enroll',
      '--server',
      'https://switch.example.com',
      '--code',
      'swce_test',
      '--name',
      'build-box',
      '--description',
      '  The build box in the office ',
      '--data-dir',
      dir,
      '--secret-store',
      'file',
    ]);
    vi.unstubAllGlobals();
    expect(code).toBe(EXIT_OK);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      controller: { kind: 'daemon', name: 'build-box', description: 'The build box in the office' },
    });
    expect(/Enrolled as controller (\S+)/.exec(stdout.join(''))?.[1]).toBe('controller-1');
    expect(stdout.join('')).not.toContain('swcc_test');
  });

  it('enrolls without a description when none is given, and refuses an overlong one', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({ controller_id: 'controller-1', credential: 'swcc_test' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    const base = [
      'enroll',
      '--server',
      'https://switch.example.com',
      '--code',
      'swce_test',
      '--secret-store',
      'file',
    ];
    expect(await main([...base, '--description', 'x'.repeat(501), '--data-dir', dir])).toBe(
      EXIT_CONFIGURATION
    );
    expect(lastLine()).toBe(
      'switch-agent-controller: --description must be at most 500 characters.'
    );
    expect(await main([...base, '--name', 'box', '--data-dir', dir])).toBe(EXIT_OK);
    vi.unstubAllGlobals();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.controller).not.toHaveProperty('description');
  });

  it('exits 2 when the data directory belongs to another controller', async () => {
    const store = ControllerStore.open(join(dir, 'controller.db'));
    store.saveIdentity({
      controllerId: 'controller-1',
      server: 'https://switch.example.com',
      name: 'box',
      enrolledAt: '2026-01-01T00:00:00.000Z',
    });
    store.close();
    const code = await main([
      'run',
      '--data-dir',
      dir,
      '--controller-id',
      'controller-2',
      '--server',
      'https://switch.example.com',
      '--shared-host-bundle',
      bundle,
    ]);
    expect(code).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toMatch(/already belongs to controller controller-1/);
  });

  it('exits 2 when the shared host bundle is missing, or the server URL is not one', async () => {
    expect(
      await main(['run', '--data-dir', dir, '--shared-host-bundle', join(dir, 'missing.mjs')])
    ).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toMatch(/shared host bundle .*missing\.mjs does not exist/);
    expect(
      await main([
        'run',
        '--data-dir',
        dir,
        '--controller-id',
        'controller-1',
        '--server',
        'http://switch.example.com',
        '--shared-host-bundle',
        bundle,
      ])
    ).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toMatch(/must use https/);
  });

  it("set-info changes the machine's name and description, and records the name", async () => {
    const store = ControllerStore.open(join(dir, 'controller.db'));
    store.saveIdentity({
      controllerId: 'controller-1',
      server: 'https://switch.example.com',
      name: 'box',
      enrolledAt: '2026-01-01T00:00:00.000Z',
    });
    store.close();
    await new FileSecretStore(dataLayout(dir).secrets).set(CONTROLLER_CREDENTIAL, 'swcc_test');
    const calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        calls.push({
          method: String(init.method),
          url,
          body: init.body ? JSON.parse(String(init.body)) : null,
          auth: headers.get('Authorization'),
        });
        const body = url.endsWith('/token')
          ? {
              access_token: 'swct_test',
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }
          : { id: 'controller-1', name: 'build-box', description: null, state: 'online' };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      })
    );
    const code = await main([
      'set-info',
      '--name',
      ' build-box ',
      '--description',
      '',
      '--data-dir',
      dir,
    ]);
    vi.unstubAllGlobals();
    expect(code).toBe(EXIT_OK);
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', 'https://switch.example.com/v1/management/controllers/controller-1/token'],
      ['PATCH', 'https://switch.example.com/v1/management/controllers/controller-1'],
    ]);
    expect(calls[0]!.body).toEqual({ credential: 'swcc_test' });
    expect(calls[1]!.body).toEqual({ name: 'build-box', description: null });
    expect(calls[1]!.auth).toBe('Bearer swct_test');
    const reopened = ControllerStore.open(join(dir, 'controller.db'));
    expect(reopened.identity()?.name).toBe('build-box');
    reopened.close();
  });

  it('set-info refuses what it cannot send, before calling Switch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await main(['set-info', '--data-dir', dir])).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toBe(
      'switch-agent-controller: set-info needs --name, --description, or both.'
    );
    expect(await main(['set-info', '--name', '  ', '--data-dir', dir])).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toBe('switch-agent-controller: --name must not be blank.');
    expect(await main(['set-info', '--name', 'box', '--data-dir', dir])).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toMatch(/holds no enrolled controller/);
    vi.unstubAllGlobals();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('set-info exits 1 when Switch refuses the change', async () => {
    const store = ControllerStore.open(join(dir, 'controller.db'));
    store.saveIdentity({
      controllerId: 'controller-1',
      server: 'https://switch.example.com',
      name: 'box',
      enrolledAt: '2026-01-01T00:00:00.000Z',
    });
    store.close();
    await new FileSecretStore(dataLayout(dir).secrets).set(CONTROLLER_CREDENTIAL, 'swcc_test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/token')
          ? new Response(
              JSON.stringify({
                access_token: 'swct_test',
                expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              }),
              { status: 200 }
            )
          : new Response(
              JSON.stringify({
                error: { code: 'validation_error', message: 'name too long', retryable: false },
              }),
              { status: 422 }
            )
      )
    );
    expect(await main(['set-info', '--name', 'box', '--data-dir', dir])).toBe(EXIT_FAILURE);
    vi.unstubAllGlobals();
    expect(lastLine()).toBe('switch-agent-controller: validation_error: name too long');
    const reopened = ControllerStore.open(join(dir, 'controller.db'));
    expect(reopened.identity()?.name).toBe('box');
    reopened.close();
  });

  it('exits 2 when it is not enrolled', async () => {
    expect(await main(['run', '--data-dir', dir, '--shared-host-bundle', bundle])).toBe(
      EXIT_CONFIGURATION
    );
    expect(lastLine()).toMatch(/not enrolled/);
  });
});

function saveStatusIdentity(): void {
  const store = ControllerStore.open(dataLayout(dir).database);
  store.saveIdentity({
    controllerId: 'controller-1',
    name: 'build-box',
    server: 'https://switch.example',
    enrolledAt: '2026-10-29T00:00:00Z',
  });
  store.saveSecretStoreKind('file');
  store.close();
}

describe('CLI output and compatibility', () => {
  it.each([false, true])('preserves the unenrolled status exit code (json=%s)', async (json) => {
    expect(await main(['status', '--data-dir', dir, ...(json ? ['--json'] : [])])).toBe(1);
    const text = stdout.join('');
    expect(text).not.toContain('\u001b');
    if (json)
      expect(JSON.parse(text)).toMatchObject({
        schemaVersion: 1,
        command: 'status',
        identity: null,
        agents: [],
        credential: 'not-checked',
      });
    else expect(text).toContain('Not enrolled.');
    expect(stderr).toEqual([]);
  });

  it('returns JSON for enrolled, revoked, missing and unreadable assignments without changing exit codes', async () => {
    saveStatusIdentity();
    const command = ['status', '--json', '--data-dir', dir];
    expect(await main(command)).toBe(EXIT_OK);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      identity: { controllerId: 'controller-1' },
      credential: 'missing',
      assignment: { state: 'none' },
    });
    const store = ControllerStore.open(dataLayout(dir).database);
    store.saveAssignment({ revision: 3, agents: [] }, null, '2026-10-29T00:00:00Z');
    store.close();
    const db = new DatabaseSync(dataLayout(dir).database);
    db.prepare('UPDATE assignment SET body = ? WHERE id = 1').run('{broken');
    db.close();
    stdout.length = 0;
    expect(await main(command)).toBe(EXIT_OK);
    expect(JSON.parse(stdout.join('')).assignment).toMatchObject({
      state: 'unreadable',
      revision: null,
    });
    const revoked = ControllerStore.open(dataLayout(dir).database);
    revoked.markRevoked('2026-10-29T01:00:00Z');
    revoked.close();
    stdout.length = 0;
    expect(await main(command)).toBe(EXIT_OK);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      revokedAt: '2026-10-29T01:00:00Z',
      credential: 'not-checked',
    });
  });

  it('uses the same agent data in text and JSON without exposing credentials', async () => {
    saveStatusIdentity();
    const store = ControllerStore.open(dataLayout(dir).database);
    store.saveAssignment(
      assignmentSchema.parse({
        revision: 3,
        agents: [
          {
            agent_id: 'agent-1',
            revision: 2,
            desired_state: 'running',
            definition: {
              name: 'scout',
              display_name: null,
              icon_url: null,
              provider: 'claude',
              model: null,
              advanced_config: {},
              instructions: '',
              auto_approve: false,
              auto_mode: false,
              directory: null,
              isolation: 'shared',
            },
          },
        ],
      }),
      null,
      '2026-10-29T00:00:00Z'
    );
    store.close();
    await new FileSecretStore(dataLayout(dir).secrets).set(
      CONTROLLER_CREDENTIAL,
      'credential-placeholder'
    );
    expect(await main(['status', '--json', '--data-dir', dir])).toBe(EXIT_OK);
    const raw = stdout.join('');
    const report = JSON.parse(raw);
    expect(report).toMatchObject({
      credential: 'present',
      assignment: { state: 'ready', revision: 3 },
      agents: [{ id: 'agent-1', name: 'scout', provider: 'claude', revision: 2 }],
    });
    expect(raw).not.toContain('credential-placeholder');
    stdout.length = 0;
    expect(await main(['status', '--data-dir', dir])).toBe(EXIT_OK);
    for (const value of ['scout', 'agent-1', 'claude']) expect(stdout.join('')).toContain(value);
  });

  it.each([false, true])(
    'doctor retains failure exit codes and exposes check fixes (json=%s)',
    async (json) => {
      const checks: doctor.Check[] = [
        {
          name: 'Enrollment',
          status: 'fail',
          detail: 'Not enrolled.',
          fix: 'Get a code from Machines.',
        },
      ];
      vi.spyOn(doctor, 'runDoctor').mockResolvedValue(checks);
      expect(await main(['doctor', '--data-dir', dir, ...(json ? ['--json'] : [])])).toBe(1);
      const text = stdout.join('');
      if (json)
        expect(JSON.parse(text)).toMatchObject({
          schemaVersion: 1,
          command: 'doctor',
          checks,
          summary: { ok: 0, warn: 0, fail: 1 },
        });
      else expect(text).toContain('Fix: Get a code from Machines.');
      expect(text).not.toContain('\u001b');
    }
  );

  it('doctor warnings do not change its success exit code', async () => {
    vi.spyOn(doctor, 'runDoctor').mockResolvedValue([
      { name: 'Service', status: 'warn', detail: 'Not installed' },
    ]);
    expect(await main(['doctor', '--json', '--data-dir', dir])).toBe(EXIT_OK);
    expect(JSON.parse(stdout.join('')).summary).toEqual({ ok: 0, warn: 1, fail: 0 });
  });

  it.each(['status', 'doctor'])('emits parseable JSON for %s argument errors', async (command) => {
    expect(await main([command, '--json', '--unknown'])).toBe(EXIT_CONFIGURATION);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      schemaVersion: 1,
      command,
      error: { exitCode: 2 },
    });
    expect(stderr).toEqual([]);
  });

  it('emits a JSON failure if a doctor check unexpectedly throws', async () => {
    vi.spyOn(doctor, 'runDoctor').mockRejectedValue(new Error('check failed'));
    expect(await main(['doctor', '--json', '--data-dir', dir])).toBe(EXIT_FAILURE);
    expect(JSON.parse(stdout.join('')).error).toEqual({ exitCode: 1, message: 'check failed' });
  });

  it('keeps help, version and protocol exit codes and machine-readable values', async () => {
    expect(await main(['--version'])).toBe(EXIT_OK);
    expect(stdout.join('')).toBe(`${VERSION}\n`);
    stdout.length = 0;
    expect(await main(['--protocol'])).toBe(EXIT_OK);
    expect(stdout.join('')).toMatch(/^\d+\n$/);
    for (const command of ['help', '--help', '-h']) {
      stdout.length = 0;
      expect(await main([command])).toBe(EXIT_OK);
      expect(stdout.join('')).toContain('Diagnostics and updates:');
      expect(stdout.join('')).toContain('status [--json]');
    }
  });

  it('keeps update check and missing-release exit codes without installing anything', async () => {
    const latest = vi.spyOn(update, 'latestRelease').mockResolvedValue(null);
    expect(await main(['update', '--check'])).toBe(1);
    expect(stdout.join('')).toContain('[WARN]');
    latest.mockResolvedValue({
      version: VERSION,
      packageUrl: 'https://example.invalid/controller.tgz',
    });
    expect(await main(['update', '--check'])).toBe(EXIT_OK);
    latest.mockResolvedValue({
      version: '99.0.0',
      packageUrl: 'https://example.invalid/controller.tgz',
    });
    expect(await main(['update', '--check'])).toBe(EXIT_OK);
    expect(stdout.join('')).toContain('Install it with: switch-agent-controller update');
  });

  it('formats service installation/removal without touching the real service manager', async () => {
    saveStatusIdentity();
    vi.spyOn(service, 'installService').mockResolvedValue({
      file: '/example/controller.service',
      notes: ['Starts at login.'],
    });
    const remove = vi.spyOn(service, 'uninstallService').mockResolvedValue(true);
    expect(await main(['install-service', '--data-dir', dir, '--shared-host-bundle', bundle])).toBe(
      EXIT_OK
    );
    expect(stdout.join('')).toMatch(
      /\[OK\]\s+Installed and started: \/example\/controller.service/
    );
    expect(stdout.join('')).toContain('  Starts at login.');
    expect(await main(['uninstall-service', '--data-dir', dir])).toBe(EXIT_OK);
    remove.mockResolvedValue(false);
    expect(await main(['uninstall-service', '--data-dir', dir])).toBe(EXIT_OK);
    expect(stdout.join('')).toMatch(/\[INFO\]\s+No service was installed./);
  });

  it('formats the separate-users service paths without creating system users', async () => {
    vi.spyOn(separateUsers, 'installSeparateUsers').mockResolvedValue({
      notes: ['System service started.'],
    });
    vi.spyOn(separateUsers, 'uninstallSeparateUsers').mockResolvedValue({
      notes: ['Agent directories kept.'],
    });
    expect(
      await main([
        'install-service',
        '--separate-users',
        '--user',
        'controller-user',
        '--data-dir',
        dir,
        '--shared-host-bundle',
        bundle,
      ])
    ).toBe(EXIT_OK);
    expect(await main(['uninstall-service', '--separate-users', '--user', 'controller-user'])).toBe(
      EXIT_OK
    );
    expect(stdout.join('')).toContain('Agents now run as users of their own.');
    expect(stdout.join('')).toContain('Removed the setup for agents as users of their own.');
  });

  it('preserves service command failures and puts their reason last on stderr', async () => {
    vi.spyOn(service, 'uninstallService').mockRejectedValue(
      new Error('\u001b[31mservice manager refused\u001b[0m')
    );
    expect(await main(['uninstall-service', '--data-dir', dir])).toBe(EXIT_FAILURE);
    expect(lastLine()).toBe('switch-agent-controller: service manager refused');
    expect(stderr.join('')).not.toContain('\u001b');
  });
});

describe('infoChange', () => {
  it('trims, clears a blank description, and keeps to the limits', () => {
    expect(infoChange({ name: ' box ' })).toEqual({ name: 'box' });
    expect(infoChange({ description: '  ' })).toEqual({ description: null });
    expect(infoChange({ name: 'x'.repeat(200), description: 'y'.repeat(500) })).toEqual({
      name: 'x'.repeat(200),
      description: 'y'.repeat(500),
    });
    expect(() => infoChange({ name: 'x'.repeat(201) })).toThrow(/at most 200/);
    expect(() => infoChange({ description: 'y'.repeat(501) })).toThrow(/at most 500/);
  });
});

describe('isSupervised', () => {
  it('restarts on 7 under the separate-users service, launchd, or anything systemd runs', () => {
    expect(isSupervised(null, false, {})).toBe(false);
    expect(
      isSupervised(
        {
          v: 1,
          user: 'builder',
          uid: 1001,
          gid: 990,
          dataDir: '/var/lib/controller',
          agentsDir: '/var/lib/switch-agents/1001',
          agentUsers: 4,
          node: '/usr/bin/node',
          bundle: '/opt/shared-host.mjs',
          releasesDir: null,
        },
        false,
        {}
      )
    ).toBe(true);
    expect(isSupervised(null, true, {})).toBe(true);
    expect(isSupervised(null, false, { INVOCATION_ID: 'abc' })).toBe(true);
  });
});

const NPM = { run: vi.fn(), node: 'node', cacheDir: 'cache', env: {} };

describe('installerFor', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'installer-for-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('says a Windows controller does not update itself, whatever it runs from', async () => {
    const installer = await installerFor(null, null, NPM, 'win32');
    expect(installer.unavailable).toMatch(/Linux and macOS only/);
  });

  it.skipIf(process.platform === 'win32')(
    'installs into the releases directory a service runs through',
    async () => {
      const releasesDir = join(root, 'releases');
      mkdirSync(releasesDir);
      expect((await installerFor(null, releasesDir, NPM, 'linux')).unavailable).toMatch(
        /no current link/
      );
      symlinkSync(join(root, 'prefix'), join(releasesDir, 'current'));
      const installer = await installerFor(null, releasesDir, NPM, 'linux');
      expect(installer.unavailable).toBeNull();
      expect(installer).toBeInstanceOf(ReleasesDirInstaller);
    }
  );
});

describe.skipIf(process.platform === 'win32')('planServiceReleases', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'service-releases-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const cliIn = (prefix: string) =>
    join(prefix, 'lib', 'node_modules', 'switch-agent-controller', 'dist', 'cli.js');

  it('runs an npm install through <data dir>/releases', async () => {
    const dir = join(root, 'data', 'releases');
    expect(await planServiceReleases(cliIn('/home/me/.local'), dir)).toEqual({
      dir,
      prefix: '/home/me/.local',
    });
  });

  it('has none for a checkout', async () => {
    expect(await planServiceReleases('/src/switch/console/dist/cli.js', root)).toBeNull();
  });

  it('runs again from a release of its own directory, and refuses another setup’s', async () => {
    const own = join(root, 'data', 'releases');
    const other = join(root, 'var', 'releases');
    for (const dir of [own, other]) {
      mkdirSync(join(dir, '0.31.0'), { recursive: true });
      symlinkSync(join(dir, '0.31.0'), join(dir, 'current'));
    }
    expect(await planServiceReleases(cliIn(join(own, '0.31.0')), own)).toEqual({
      dir: own,
      prefix: join(own, '0.31.0'),
    });
    await expect(planServiceReleases(cliIn(join(other, '0.31.0')), own)).rejects.toThrow(
      /releases directory of another setup/
    );
  });
});
