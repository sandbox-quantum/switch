import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from './log';
import { packageDir } from './releases';
import {
  type ControllerReleaseTarget,
  downloadVerified,
  type InstallRunner,
  type NpmSetup,
  PrefixInstaller,
  readControllerRelease,
  type ReleaseInstaller,
  ReleasesDirInstaller,
  RETRY_AFTER_MS,
  SelfUpdater,
  type UpdateAttempt,
  type UpdateHost,
  unavailableInstaller,
} from './self-update';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'self-update-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SHA = 'a'.repeat(64);

describe('readControllerRelease', () => {
  it('is none when absent or null', () => {
    expect(readControllerRelease(undefined)).toEqual({ release: null, problem: null });
    expect(readControllerRelease(null)).toEqual({ release: null, problem: null });
  });

  it('reads a release, with its SHA-256 in lower case', () => {
    expect(
      readControllerRelease({
        version: '0.31.0',
        url: 'https://example.invalid/switch-agent-controller-0.31.0.tgz',
        sha256: SHA.toUpperCase(),
        extra: 'ignored',
      })
    ).toEqual({
      release: {
        version: '0.31.0',
        url: 'https://example.invalid/switch-agent-controller-0.31.0.tgz',
        sha256: SHA,
      },
      problem: null,
    });
  });

  it("reads a dev build's version", () => {
    const read = readControllerRelease({
      version: '0.31.1-dev.412.gabc1234',
      url: 'https://example.invalid/switch-agent-controller-0.31.1-dev.412.gabc1234.tgz',
      sha256: SHA,
    });
    expect(read.problem).toBeNull();
    expect(read.release?.version).toBe('0.31.1-dev.412.gabc1234');
  });

  it('treats a malformed one as none, and says why', () => {
    for (const raw of [
      'latest',
      { version: '0.31', url: 'https://example.invalid/a.tgz', sha256: SHA },
      { version: '0.31.0', url: 'ftp://example.invalid/a.tgz', sha256: SHA },
      { version: '0.31.0', url: 'https://example.invalid/a.tgz', sha256: 'abc' },
      { version: '../../etc', url: 'https://example.invalid/a.tgz', sha256: SHA },
      { version: '0.31.0-dev..1', url: 'https://example.invalid/a.tgz', sha256: SHA },
      { version: '0.31.0-dev/../x', url: 'https://example.invalid/a.tgz', sha256: SHA },
    ]) {
      const read = readControllerRelease(raw);
      expect(read.release).toBeNull();
      expect(read.problem).toBeTruthy();
    }
  });
});

function serving(body: Buffer, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response(new Uint8Array(body), { status: 200, headers })) as typeof fetch;
}

/** A body sent in chunks, with no Content-Length to go by. */
function streaming(chunks: Buffer[]): typeof fetch {
  return (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
          controller.close();
        },
      }),
      { status: 200 }
    )) as typeof fetch;
}

function releaseOf(body: Buffer, version = '0.31.0'): ControllerReleaseTarget {
  return {
    version,
    url: `https://example.invalid/switch-agent-controller-${version}.tgz`,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}

describe('downloadVerified', () => {
  it('keeps a package whose SHA-256 is the one Switch named', async () => {
    const body = Buffer.from('a package');
    const file = await downloadVerified({
      fetch: serving(body),
      release: releaseOf(body),
      dir: join(dir, 'updates'),
      maxBytes: 1024,
      signal: null,
    });
    expect(readFileSync(file)).toEqual(body);
    expect(dirname(file)).toBe(join(dir, 'updates'));
  });

  it('deletes a package whose SHA-256 differs', async () => {
    const body = Buffer.from('a package');
    await expect(
      downloadVerified({
        fetch: serving(Buffer.from('another package')),
        release: releaseOf(body),
        dir: join(dir, 'updates'),
        maxBytes: 1024,
        signal: null,
      })
    ).rejects.toThrow(/not the [0-9a-f]{64} Switch named/);
    expect(readdirSync(join(dir, 'updates'))).toEqual([]);
  });

  it('refuses a package larger than the cap, declared or sent', async () => {
    const body = Buffer.alloc(2048, 1);
    await expect(
      downloadVerified({
        fetch: serving(body, { 'content-length': '2048' }),
        release: releaseOf(body),
        dir: join(dir, 'updates'),
        maxBytes: 1024,
        signal: null,
      })
    ).rejects.toThrow(/2048 bytes, more than the 1024/);
    await expect(
      downloadVerified({
        fetch: streaming([body.subarray(0, 1000), body.subarray(1000)]),
        release: releaseOf(body),
        dir: join(dir, 'updates'),
        maxBytes: 1024,
        signal: null,
      })
    ).rejects.toThrow(/more than the 1024 bytes/);
    expect(readdirSync(join(dir, 'updates'))).toEqual([]);
  });

  it('fails loud when the server refuses', async () => {
    const refusing = (async () => new Response('gone', { status: 404 })) as typeof fetch;
    await expect(
      downloadVerified({
        fetch: refusing,
        release: releaseOf(Buffer.from('x')),
        dir: join(dir, 'updates'),
        maxBytes: 1024,
        signal: null,
      })
    ).rejects.toThrow(/404/);
  });
});

/**
 * Stands in for npm and node: `install --global --prefix P <file>` installs
 * the release whose version the file holds into P; `node <cli> --version`
 * says the version of the release `cli` is in.
 */
function fakeNpm(options: { says?: string } = {}) {
  const calls: string[][] = [];
  const run: InstallRunner = async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === 'install') {
      const prefix = args[args.indexOf('--prefix') + 1]!;
      const version = readFileSync(args.at(-1)!, 'utf8').trim();
      const pkg = packageDir(prefix);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version }));
      writeFileSync(join(pkg, 'cli.mjs'), '');
      mkdirSync(join(prefix, 'bin'), { recursive: true });
      symlinkSync(
        '../lib/node_modules/switch-agent-controller/cli.mjs',
        join(prefix, 'bin', 'switch-agent-controller')
      );
      return { stdout: '' };
    }
    if (args[1] === '--version') {
      const cli = args[0]!;
      const pkg = cli.includes('/bin/') ? packageDir(dirname(dirname(cli))) : dirname(cli);
      const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;
      return { stdout: `${options.says ?? version}\n` };
    }
    throw new Error(`Unexpected command ${file} ${args.join(' ')}`);
  };
  const setup: NpmSetup = {
    run,
    node: '/opt/node/bin/node',
    cacheDir: join(dir, 'npm-cache'),
    env: { PATH: '/usr/bin' },
  };
  return { setup, calls };
}

/** A downloaded package, as the fake npm reads it. */
function packageFile(version: string): string {
  const file = join(dir, `package-${version}.tgz`);
  writeFileSync(file, version);
  return file;
}

/** A release already in the releases directory, installed `ageS` seconds ago. */
function installed(releases: string, version: string, ageS: number): string {
  const prefix = join(releases, version);
  mkdirSync(packageDir(prefix), { recursive: true });
  writeFileSync(join(packageDir(prefix), 'package.json'), JSON.stringify({ version }));
  const at = new Date(Date.now() - ageS * 1000);
  utimesSync(prefix, at, at);
  return prefix;
}

describe.skipIf(process.platform === 'win32')('ReleasesDirInstaller', () => {
  it('installs beside the others, switches current, and keeps the previous release and one older', async () => {
    const releases = join(dir, 'releases');
    mkdirSync(releases);
    installed(releases, '0.28.0', 400);
    installed(releases, '0.29.0', 300);
    const previous = installed(releases, '0.30.0', 200);
    mkdirSync(join(releases, '0.27.0.partial'));
    symlinkSync(previous, join(releases, 'current'));
    const npm = fakeNpm();
    const installer = new ReleasesDirInstaller({ npm: npm.setup, releasesDir: releases });

    await installer.prepare('0.31.0', packageFile('0.31.0'), null);
    expect(readlinkSync(join(releases, 'current'))).toBe(previous);
    expect(existsSync(join(releases, '0.31.0.partial'))).toBe(false);
    await installer.activate('0.31.0');

    expect(readlinkSync(join(releases, 'current'))).toBe(join(releases, '0.31.0'));
    expect(readdirSync(releases).sort()).toEqual(['0.29.0', '0.30.0', '0.31.0', 'current']);
    expect(npm.calls[0]).toEqual([
      'npm',
      'install',
      '--global',
      '--prefix',
      join(releases, '0.31.0.partial'),
      join(dir, 'package-0.31.0.tgz'),
    ]);
    expect(npm.calls[1]).toEqual([
      '/opt/node/bin/node',
      join(releases, '0.31.0.partial', 'bin', 'switch-agent-controller'),
      '--version',
    ]);
  });

  it('never prunes a release outside the directory that current named', async () => {
    const releases = join(dir, 'releases');
    mkdirSync(releases);
    const baked = join(dir, 'opt', 'controller');
    mkdirSync(packageDir(baked), { recursive: true });
    symlinkSync(baked, join(releases, 'current'));
    const installer = new ReleasesDirInstaller({ npm: fakeNpm().setup, releasesDir: releases });
    await installer.prepare('0.31.0', packageFile('0.31.0'), null);
    await installer.activate('0.31.0');
    await installer.prepare('0.32.0', packageFile('0.32.0'), null);
    await installer.activate('0.32.0');
    expect(existsSync(baked)).toBe(true);
    expect(readdirSync(releases).sort()).toEqual(['0.31.0', '0.32.0', 'current']);
  });

  it('refuses a package that is not the version Switch named, leaving current as it was', async () => {
    const releases = join(dir, 'releases');
    mkdirSync(releases);
    const previous = installed(releases, '0.30.0', 10);
    symlinkSync(previous, join(releases, 'current'));
    const installer = new ReleasesDirInstaller({
      npm: fakeNpm({ says: '0.29.0' }).setup,
      releasesDir: releases,
    });
    await expect(installer.prepare('0.31.0', packageFile('0.31.0'), null)).rejects.toThrow(
      /says it is 0.29.0, not 0.31.0/
    );
    expect(readdirSync(releases).sort()).toEqual(['0.30.0', 'current']);
    expect(readlinkSync(join(releases, 'current'))).toBe(previous);
  });

  it('replaces a release of the same version installed before', async () => {
    const releases = join(dir, 'releases');
    mkdirSync(releases);
    const earlier = installed(releases, '0.31.0', 10);
    writeFileSync(join(earlier, 'stale'), '');
    const installer = new ReleasesDirInstaller({ npm: fakeNpm().setup, releasesDir: releases });
    await installer.prepare('0.31.0', packageFile('0.31.0'), null);
    await installer.activate('0.31.0');
    expect(existsSync(join(earlier, 'stale'))).toBe(false);
    expect(readdirSync(releases).sort()).toEqual(['0.31.0', 'current']);
  });
});

describe('PrefixInstaller', () => {
  it('installs over the prefix the controller came from, then checks the CLI there', async () => {
    const prefix = join(dir, 'local');
    const cli = join(packageDir(prefix), 'cli.mjs');
    const npm = fakeNpm();
    const installer = new PrefixInstaller({ npm: npm.setup, prefix, cli });
    await installer.prepare();
    expect(npm.calls).toEqual([]);
    await installer.activate('0.31.0', packageFile('0.31.0'));
    expect(npm.calls.map((call) => call.slice(1))).toEqual([
      ['install', '--global', '--prefix', prefix, join(dir, 'package-0.31.0.tgz')],
      [cli, '--version'],
    ]);
  });
});

/** An installer that records what it was asked, and fails where told. */
function recordingInstaller(fail: { prepare?: string; activate?: string } = {}) {
  const calls: string[] = [];
  const installer: ReleaseInstaller = {
    unavailable: null,
    prepare: async (version) => {
      calls.push(`prepare ${version}`);
      if (fail.prepare) throw new Error(fail.prepare);
    },
    activate: async (version) => {
      calls.push(`activate ${version}`);
      if (fail.activate) throw new Error(fail.activate);
    },
  };
  return { installer, calls };
}

function updater(
  overrides: Partial<ConstructorParameters<typeof SelfUpdater>[0]> & {
    installer: ReleaseInstaller;
  }
) {
  let saved: UpdateAttempt | null = null;
  const downloads: string[] = [];
  const clock = { now: 1_000_000 };
  const self = new SelfUpdater({
    version: '0.30.0',
    download: async (release) => {
      downloads.push(release.version);
      const file = join(dir, `download-${release.version}.tgz`);
      writeFileSync(file, '');
      return file;
    },
    attempts: { last: () => saved, save: (attempt) => void (saved = attempt) },
    supervised: true,
    log: silentLogger,
    now: () => clock.now,
    ...overrides,
  });
  return { self, downloads, clock, attempt: () => saved };
}

function host(idle: boolean | boolean[] = true) {
  const answers = Array.isArray(idle) ? [...idle] : null;
  let restarts = 0;
  const stop = new AbortController();
  const lent: UpdateHost = {
    idle: async () => (answers ? (answers.shift() ?? true) : (idle as boolean)),
    restart: () => void restarts++,
    signal: stop.signal,
  };
  return { lent, restarts: () => restarts, stop };
}

const named = {
  version: '0.31.0',
  url: 'https://example.invalid/switch-agent-controller-0.31.0.tgz',
  sha256: SHA,
};

describe('SelfUpdater', () => {
  it('leaves a controller alone when Switch names no release, or the one it runs', async () => {
    const { installer, calls } = recordingInstaller();
    const { self, downloads } = updater({ installer });
    const idle = host();
    await self.offer(undefined, idle.lent);
    await self.offer(null, idle.lent);
    await self.offer({ ...named, version: '0.30.0' }, idle.lent);
    await self.offer({ broken: true }, idle.lent);
    expect(downloads).toEqual([]);
    expect(calls).toEqual([]);
    expect(self.status()).toBeNull();
    expect(idle.restarts()).toBe(0);
  });

  it('installs another version while idle, older included, and restarts into it', async () => {
    const { installer, calls } = recordingInstaller();
    const { self, downloads } = updater({ installer });
    const idle = host();
    await self.offer({ ...named, version: '0.29.0' }, idle.lent);
    expect(downloads).toEqual(['0.29.0']);
    expect(calls).toEqual(['prepare 0.29.0', 'activate 0.29.0']);
    expect(idle.restarts()).toBe(1);
    expect(self.status()).toBeNull();
    expect(existsSync(join(dir, 'download-0.29.0.tgz'))).toBe(false);
  });

  it('waits while a session runs, and goes ahead at a later report once none does', async () => {
    const { installer, calls } = recordingInstaller();
    const { self, downloads, attempt } = updater({ installer });
    const busy = host(false);
    await self.offer(named, busy.lent);
    expect(downloads).toEqual([]);
    expect(self.status()).toEqual({ target: '0.31.0', state: 'waiting_idle' });
    expect(attempt()).toBeNull();
    const idle = host();
    await self.offer(named, idle.lent);
    expect(calls).toEqual(['prepare 0.31.0', 'activate 0.31.0']);
    expect(idle.restarts()).toBe(1);
  });

  it('checks again right before switching, and waits when a session started meanwhile', async () => {
    const { installer, calls } = recordingInstaller();
    const { self, attempt } = updater({ installer });
    const started = host([true, false]);
    await self.offer(named, started.lent);
    expect(calls).toEqual(['prepare 0.31.0']);
    expect(started.restarts()).toBe(0);
    expect(self.status()).toEqual({ target: '0.31.0', state: 'waiting_idle' });
    expect(attempt()).toBeNull();
  });

  it('reports a failure, and does not try the same release again within the hour', async () => {
    const { installer, calls } = recordingInstaller({ prepare: 'npm install failed: EACCES' });
    const { self, clock, downloads } = updater({ installer });
    const idle = host();
    await self.offer(named, idle.lent);
    expect(self.status()).toEqual({
      target: '0.31.0',
      state: 'failed',
      problem: 'npm install failed: EACCES',
    });
    clock.now += RETRY_AFTER_MS - 1;
    await self.offer(named, idle.lent);
    expect(downloads).toEqual(['0.31.0']);
    clock.now += 1;
    await self.offer(named, idle.lent);
    expect(downloads).toEqual(['0.31.0', '0.31.0']);
    expect(calls).toEqual(['prepare 0.31.0', 'prepare 0.31.0']);
    expect(idle.restarts()).toBe(0);
  });

  it('tries a release Switch names next at once, whatever failed before', async () => {
    const failing = recordingInstaller({ activate: 'broken' });
    const { self, downloads } = updater({ installer: failing.installer });
    const idle = host();
    await self.offer(named, idle.lent);
    await self.offer({ ...named, version: '0.32.0' }, idle.lent);
    expect(downloads).toEqual(['0.31.0', '0.32.0']);
  });

  it('reports a restart that came back on the old version rather than looping', async () => {
    const { installer } = recordingInstaller();
    const first = updater({ installer });
    await first.self.offer(named, host().lent);
    // The service started it again, still on 0.30.0, with the attempt kept in the store.
    const saved = first.attempt();
    const again = updater({
      installer,
      attempts: { last: () => saved, save: () => {} },
      now: () => first.clock.now + 60_000,
    });
    const idle = host();
    await again.self.offer(named, idle.lent);
    expect(again.downloads).toEqual([]);
    expect(again.self.status()).toMatchObject({ target: '0.31.0', state: 'failed' });
    expect(idle.restarts()).toBe(0);
  });

  it('says why when it cannot install a release itself', async () => {
    const { self, downloads } = updater({
      installer: unavailableInstaller('This controller runs from a checkout.'),
    });
    await self.offer(named, host().lent);
    expect(downloads).toEqual([]);
    expect(self.status()).toEqual({
      target: '0.31.0',
      state: 'failed',
      problem: 'This controller runs from a checkout.',
    });
  });

  it('outside a service, installs and says a restart is needed rather than exiting', async () => {
    const { installer, calls } = recordingInstaller();
    const { self } = updater({ installer, supervised: false });
    const idle = host();
    await self.offer(named, idle.lent);
    expect(calls).toEqual(['prepare 0.31.0', 'activate 0.31.0']);
    expect(idle.restarts()).toBe(0);
    expect(self.status()).toMatchObject({ target: '0.31.0', state: 'restart_needed' });
    await self.offer(named, idle.lent);
    expect(calls).toHaveLength(2);
  });

  it('stops short of switching when the controller is stopping', async () => {
    const { installer, calls } = recordingInstaller();
    const { self, attempt } = updater({ installer });
    const stopping = host();
    const offered = self.offer(named, stopping.lent);
    stopping.stop.abort();
    await offered;
    expect(calls).not.toContain('activate 0.31.0');
    expect(stopping.restarts()).toBe(0);
    expect(attempt()).toBeNull();
  });
});
