import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_CONFIGURATION, EXIT_FAILURE, EXIT_OK } from './exit-codes';
import {
  boxModeFrom,
  infoChange,
  installerFor,
  isSupervised,
  main,
  planServiceReleases,
} from './main';
import { dataLayout } from './paths';
import { CONTROLLER_CREDENTIAL, FileSecretStore } from './secrets';
import { ReleasesDirInstaller } from './self-update';
import { ControllerStore } from './store';

let dir: string;
let bundle: string;
let stderr: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-main-'));
  bundle = join(dir, 'shared-host.mjs');
  writeFileSync(bundle, '');
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  // `run` unrefs its IPC channel so a parent's channel never keeps a controller
  // alive. Here that channel is the test worker's own link to vitest: unrefed,
  // the worker can exit mid-file whenever nothing else holds its event loop.
  if (process.channel) vi.spyOn(process.channel, 'unref').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(await main(['--device-id'])).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toBe('switch-agent-controller: --device-id needs --device-root.');
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
  });

  it('says which controller it is when it took over the one this machine was', async () => {
    const written: string[] = [];
    vi.mocked(process.stdout.write).mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              controller_id: 'controller-0',
              credential: 'swcc_test',
              adopted: true,
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );
    const code = await main([
      'enroll',
      '--server',
      'https://switch.example.com',
      '--code',
      'swce_test',
      '--name',
      'build-box',
      '--data-dir',
      dir,
      '--secret-store',
      'file',
    ]);
    vi.unstubAllGlobals();
    expect(code).toBe(EXIT_OK);
    const out = written.join('');
    expect(out).toContain('which this machine was before; its agents stay on it.');
    // Switch Console reads the id off this line when it sets up an SSH host.
    expect(/Enrolled as controller (\S+)/.exec(out)?.[1]).toBe('controller-0');
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

describe('box mode', () => {
  it('refuses a box image without --box, and --box outside one, for every command', async () => {
    for (const command of ['run', 'enroll', 'status']) {
      expect(await main([command, '--box'], false)).toBe(EXIT_CONFIGURATION);
      expect(lastLine()).toBe(
        'switch-agent-controller: --box is only for the box image, which this is not.'
      );
      expect(await main([command], true)).toBe(EXIT_CONFIGURATION);
      expect(lastLine()).toBe(
        'switch-agent-controller: This is a box image: the controller runs here only in box mode (--box).'
      );
    }
  });

  it('outside box mode, knows none of the box-only commands or flags', async () => {
    expect(await main(['launcher', '--data-dir', dir], false)).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toBe("switch-agent-controller: Unknown command 'launcher'.");
    for (const flag of ['--launcher-socket', '--agents-data-dir', '--agents-workspaces']) {
      expect(await main(['run', flag, join(dir, 'x')], false)).toBe(EXIT_CONFIGURATION);
      expect(lastLine()).toMatch(new RegExp(`^switch-agent-controller: Unknown option '${flag}'`));
    }
    expect(await main(['run', '--operator-exec'], false)).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toMatch(/^switch-agent-controller: Unknown option '--operator-exec'/);
    for (const flag of ['--live', '--json']) {
      expect(await main(['status', flag], false)).toBe(EXIT_CONFIGURATION);
      expect(lastLine()).toMatch(new RegExp(`^switch-agent-controller: Unknown option '${flag}'`));
    }
  });

  it('outside box mode, leaves the gateway proxy variable alone', async () => {
    process.env.SWITCH_CONTROLLER_GATEWAY_PROXY = 'http://proxy.example:3128';
    try {
      await main(['run', '--no-such-flag'], false);
      await main(['status', '--data-dir', join(dir, 'none')], false);
      expect(process.env.SWITCH_CONTROLLER_GATEWAY_PROXY).toBe('http://proxy.example:3128');
    } finally {
      delete process.env.SWITCH_CONTROLLER_GATEWAY_PROXY;
    }
  });

  it('takes --box out of the arguments, and leaves desktop and v1 arguments as they are', () => {
    expect(boxModeFrom(['--data-dir', '/data', '--box', '--updated-by-console'], true)).toEqual({
      box: true,
      rest: ['--data-dir', '/data', '--updated-by-console'],
    });
    expect(boxModeFrom(['--data-dir', '/data'], false)).toEqual({
      box: false,
      rest: ['--data-dir', '/data'],
    });
  });
});

describe('in box mode', () => {
  it('reads the live status file for status --live and --json, and nothing else', async () => {
    expect(await main(['status', '--box', '--live', '--live-dir', dir], true)).toBe(EXIT_FAILURE);
    expect(lastLine()).toBe(
      `No live status in ${dir}: the controller is not running here, or has not written one yet.`
    );
    expect(await main(['status', '--box', '--live-dir', dir], true)).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toBe(
      'switch-agent-controller: --live-dir and --since go with --live or --json.'
    );
  });

  it('takes the gateway proxy out of the environment before any command', async () => {
    process.env.SWITCH_CONTROLLER_GATEWAY_PROXY = 'http://proxy.example:3128';
    try {
      await main(['status', '--box', '--live', '--live-dir', dir], true);
      expect(process.env).not.toHaveProperty('SWITCH_CONTROLLER_GATEWAY_PROXY');
    } finally {
      delete process.env.SWITCH_CONTROLLER_GATEWAY_PROXY;
    }
  });

  it('sends no device id', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    expect(await main(['--device-id', '--device-root', dir, '--box'], true)).toBe(EXIT_OK);
    expect(out.join('')).toBe('\n');
  });

  it('refuses operator exec unless the template marks a split test box', async () => {
    expect(await main(['run', '--box', '--operator-exec'], true)).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toMatch(/--operator-exec is for test boxes only/);
  });
});
