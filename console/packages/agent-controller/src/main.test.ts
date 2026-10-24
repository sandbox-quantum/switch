import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_CONFIGURATION, EXIT_FAILURE, EXIT_OK } from './exit-codes';
import { infoChange, installerFor, isSupervised, main, planServiceReleases } from './main';
import { dataLayout } from './paths';
import { CONTROLLER_CREDENTIAL, FileSecretStore } from './secrets';
import { ReleasesDirInstaller } from './self-update';
import { ControllerStore } from './store';

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
  rmSync(dir, { recursive: true, force: true });
});

/** The last line the CLI wrote to stderr: the reason a parent shows. */
function lastLine(): string {
  return stderr.join('').trimEnd().split('\n').at(-1) ?? '';
}

function fullStdout(): string {
  return stdout.join('');
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
    ]);
    vi.unstubAllGlobals();
    expect(code).toBe(EXIT_OK);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      controller: { kind: 'daemon', name: 'build-box', description: 'The build box in the office' },
    });
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
    const base = ['enroll', '--server', 'https://switch.example.com', '--code', 'swce_test'];
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

  it('status reports not enrolled with clear problem and fix, and exits 1', async () => {
    const code = await main(['status', '--data-dir', dir]);
    expect(code).toBe(1);
    const out = fullStdout();
    expect(out).toContain('MACHINE & CONTROLLER');
    expect(out).toContain('Not enrolled');
    expect(out).toContain('Problem: This controller is not enrolled.');
    expect(out).toContain('Fix: Run: switch-agent-controller enroll');
  });

  it('status --json outputs valid JSON when not enrolled, and exits 1', async () => {
    const code = await main(['status', '--data-dir', dir, '--json']);
    expect(code).toBe(1);
    const parsed = JSON.parse(fullStdout());
    expect(parsed).toEqual({ enrolled: false, data_dir: dir, agents_runtime: null });
  });

  it('status formats sections and agent table with problem fix when enrolled', async () => {
    const store = ControllerStore.open(join(dir, 'controller.db'));
    store.saveIdentity({
      controllerId: 'controller-1',
      server: 'https://switch.example.com',
      name: 'build-box',
      enrolledAt: '2026-01-01T00:00:00.000Z',
    });
    store.saveAssignment(
      {
        revision: 2,
        agents: [
          {
            agent_id: 'agent-1',
            revision: 2,
            desired_state: 'running',
            definition: {
              name: 'Claude Worker',
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
      },
      null,
      '2026-01-01T00:00:00.000Z'
    );
    store.recordFailure(
      'agent-1',
      { revision: 2, reason: 'provider_login_missing', detail: 'Run claude auth login' },
      '2026-01-01T00:00:00.000Z'
    );
    store.close();

    const code = await main(['status', '--data-dir', dir]);
    expect(code).toBe(EXIT_OK);
    const out = fullStdout();
    expect(out).toContain('MACHINE & CONTROLLER');
    expect(out).toContain('Enrolled');
    expect(out).toContain('controller-1');
    expect(out).toContain('ASSIGNMENT');
    expect(out).toContain('Revision 2');
    expect(out).toContain('AGENTS');
    expect(out).toContain('NAME');
    expect(out).toContain('Claude Worker');
    expect(out).toContain('agent-1');
    expect(out).toContain('provider_login_missing');
    expect(out).toContain('Fix: Sign in with the provider CLI');
  });

  it('status --json outputs structured assignment and agent info when enrolled', async () => {
    const store = ControllerStore.open(join(dir, 'controller.db'));
    store.saveIdentity({
      controllerId: 'controller-1',
      server: 'https://switch.example.com',
      name: 'build-box',
      enrolledAt: '2026-01-01T00:00:00.000Z',
    });
    store.saveAssignment(
      {
        revision: 1,
        agents: [
          {
            agent_id: 'agent-1',
            revision: 1,
            desired_state: 'running',
            definition: {
              name: 'Claude Worker',
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
      },
      null,
      '2026-01-01T00:00:00.000Z'
    );
    store.close();

    const code = await main(['status', '--data-dir', dir, '--json']);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(fullStdout());
    expect(parsed.enrolled).toBe(true);
    expect(parsed.controller.id).toBe('controller-1');
    expect(parsed.controller.name).toBe('build-box');
    expect(parsed.assignment.revision).toBe(1);
    expect(parsed.assignment.agents).toHaveLength(1);
    expect(parsed.assignment.agents[0].name).toBe('Claude Worker');
    expect(parsed.assignment.agents[0].provider).toBe('claude');
  });

  it('doctor formats checks with summary and exits 1 when checks fail', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );
    try {
      const code = await main(['doctor', '--data-dir', dir]);
      expect(code).toBe(1);
      const out = fullStdout();
      expect(out).toContain('Node');
      expect(out).toContain('Platform');
      expect(out).toContain('Enrollment');
      expect(out).toContain('Summary:');
      expect(out).toMatch(/\d+ failed/);
    } finally {
      process.env.PATH = originalPath;
      vi.unstubAllGlobals();
    }
  });

  it('doctor --json outputs structured JSON with ok: false and summary', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );
    try {
      const code = await main(['doctor', '--data-dir', dir, '--json']);
      expect(code).toBe(1);
      const parsed = JSON.parse(fullStdout());
      expect(parsed.ok).toBe(false);
      expect(Array.isArray(parsed.checks)).toBe(true);
      expect(parsed.checks.some((c: { name: string }) => c.name === 'Enrollment')).toBe(true);
      expect(parsed.summary.failures).toBeGreaterThanOrEqual(1);
    } finally {
      process.env.PATH = originalPath;
      vi.unstubAllGlobals();
    }
  });

  it('update formats up-to-date and --check messages cleanly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                tag_name: 'switch-agent-controller-v99.9.9',
                draft: false,
                prerelease: false,
                assets: [
                  {
                    name: 'switch-agent-controller-99.9.9.tgz',
                    browser_download_url: 'https://example.invalid/p.tgz',
                  },
                ],
              },
            ]),
            { status: 200 }
          )
      )
    );
    const code = await main(['update', '--check', '--data-dir', dir]);
    vi.unstubAllGlobals();
    expect(code).toBe(EXIT_OK);
    expect(fullStdout()).toContain('Update available: 99.9.9');
    expect(fullStdout()).toContain('Run: switch-agent-controller update');
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
