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
import { ConfigurationError } from './errors';
import { silentLogger } from './log';
import { NO_TRUSTED_KEYS } from './release-signing';
import { packageDir } from './releases';
import {
  type ControllerReleaseTarget,
  downloadPackage,
  downloadVerified,
  type InstallRunner,
  type NpmSetup,
  PrefixInstaller,
  readControllerRelease,
  type ReleaseInstaller,
  ReleasesDirInstaller,
  RETRY_AFTER_MS,
  SELF_UPDATE_OFF,
  SelfUpdater,
  selfUpdateTurnedOff,
  type UpdateAttempt,
  type UpdateHost,
  unavailableInstaller,
} from './self-update';
import { signRelease, testSigningKey } from './testing/release-signing';

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
      { version: '0.31.0', url: 'http://example.invalid/a.tgz', sha256: SHA },
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

const KEY = testSigningKey('release-test');
const KEYS = [KEY.trusted];

/**
 * Serves `body` at the package URL and, at `<url>.sig`, `signature` (by
 * default the release signature of `body` as `release` names it); 404 for it
 * when `signature` is null. Records the URLs fetched.
 */
function serving(
  body: Buffer | (() => Response),
  options: { headers?: Record<string, string>; signature?: string | null; version?: string } = {}
) {
  const fetched: string[] = [];
  const version = options.version ?? '0.31.0';
  const fetchImpl = (async (requested: string | URL | Request) => {
    const url = String(requested);
    fetched.push(url);
    if (url.endsWith('.sig')) {
      const signature =
        options.signature === undefined
          ? Buffer.isBuffer(body)
            ? signRelease(KEY, version, createHash('sha256').update(body).digest('hex'))
            : null
          : options.signature;
      return signature === null
        ? new Response('not found', { status: 404 })
        : new Response(signature, { status: 200 });
    }
    return Buffer.isBuffer(body)
      ? new Response(new Uint8Array(body), { status: 200, headers: options.headers ?? {} })
      : body();
  }) as typeof fetch;
  return { fetch: fetchImpl, fetched };
}

/** A body sent in chunks, with no Content-Length to go by. */
function streaming(chunks: Buffer[]): () => Response {
  return () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
          controller.close();
        },
      }),
      { status: 200 }
    );
}

function releaseOf(body: Buffer, version = '0.31.0'): ControllerReleaseTarget {
  return {
    version,
    url: `https://example.invalid/switch-agent-controller-${version}.tgz`,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}

describe('downloadVerified', () => {
  const download = (
    served: ReturnType<typeof serving>,
    release: ControllerReleaseTarget,
    keys = KEYS
  ) =>
    downloadVerified({
      fetch: served.fetch,
      release,
      keys,
      dir: join(dir, 'updates'),
      maxBytes: 1024,
      signal: null,
    });

  it('keeps a package whose SHA-256 is the one Switch named and whose signature verifies', async () => {
    const body = Buffer.from('a package');
    const served = serving(body);
    const file = await download(served, releaseOf(body));
    expect(readFileSync(file)).toEqual(body);
    expect(dirname(file)).toBe(join(dir, 'updates'));
    expect(served.fetched).toEqual([
      'https://example.invalid/switch-agent-controller-0.31.0.tgz',
      'https://example.invalid/switch-agent-controller-0.31.0.tgz.sig',
    ]);
  });

  it('deletes a package whose SHA-256 differs', async () => {
    const body = Buffer.from('a package');
    await expect(
      download(serving(Buffer.from('another package')), releaseOf(body))
    ).rejects.toThrow(/not the [0-9a-f]{64} Switch named/);
    expect(readdirSync(join(dir, 'updates'))).toEqual([]);
  });

  it('deletes a package with no signature', async () => {
    const body = Buffer.from('a package');
    await expect(download(serving(body, { signature: null }), releaseOf(body))).rejects.toThrow(
      /has no signature.*404.*was deleted/
    );
    expect(readdirSync(join(dir, 'updates'))).toEqual([]);
  });

  it('deletes a package signed by a key this controller does not trust', async () => {
    const body = Buffer.from('a package');
    const sha256 = createHash('sha256').update(body).digest('hex');
    const signature = signRelease(testSigningKey('someone-else'), '0.31.0', sha256);
    await expect(download(serving(body, { signature }), releaseOf(body))).rejects.toThrow(
      /does not verify.*\(release-test\).*was deleted/
    );
    expect(readdirSync(join(dir, 'updates'))).toEqual([]);
  });

  it('deletes a package whose signature is for another version', async () => {
    const body = Buffer.from('a package');
    // Switch names a signed 0.30.0 package as 0.31.0, and gives its true SHA-256.
    await expect(
      download(serving(body, { version: '0.30.0' }), releaseOf(body, '0.31.0'))
    ).rejects.toThrow(/does not verify switch-agent-controller 0.31.0/);
    expect(readdirSync(join(dir, 'updates'))).toEqual([]);
  });

  it('deletes a package when Switch and the signature agree on a SHA-256 the bytes do not have', async () => {
    const body = Buffer.from('a package');
    const tampered = Buffer.from('a package, tampered');
    await expect(
      download(
        serving(tampered, { signature: signRelease(KEY, '0.31.0', releaseOf(body).sha256) }),
        releaseOf(body)
      )
    ).rejects.toThrow(/not the [0-9a-f]{64} Switch named/);
    expect(readdirSync(join(dir, 'updates'))).toEqual([]);
  });

  it('downloads nothing while it trusts no signing key', async () => {
    const body = Buffer.from('a package');
    const served = serving(body);
    await expect(download(served, releaseOf(body), [])).rejects.toThrow(NO_TRUSTED_KEYS);
    expect(served.fetched).toEqual([]);
  });

  it('refuses a package larger than the cap, declared or sent', async () => {
    const body = Buffer.alloc(2048, 1);
    await expect(
      download(serving(body, { headers: { 'content-length': '2048' } }), releaseOf(body))
    ).rejects.toThrow(/2048 bytes, more than the 1024/);
    await expect(
      download(serving(streaming([body.subarray(0, 1000), body.subarray(1000)])), releaseOf(body))
    ).rejects.toThrow(/more than the 1024 bytes/);
    expect(readdirSync(join(dir, 'updates'))).toEqual([]);
  });

  it('fails loud when the server refuses', async () => {
    await expect(
      download(
        serving(() => new Response('gone', { status: 404 })),
        releaseOf(Buffer.from('x'))
      )
    ).rejects.toThrow(/404/);
  });
});

describe('downloadPackage', () => {
  it('refuses a URL that is not https, fetching nothing', async () => {
    const served = serving(Buffer.from('a package'));
    await expect(
      downloadPackage({
        fetch: served.fetch,
        url: 'http://example.invalid/switch-agent-controller-0.31.0.tgz',
        dir: join(dir, 'updates'),
        maxBytes: 1024,
        signal: null,
      })
    ).rejects.toThrow(/over https only/);
    expect(served.fetched).toEqual([]);
  });
});

describe('selfUpdateTurnedOff', () => {
  it('is off by the flag or SWITCH_CONTROLLER_SELF_UPDATE=off, on otherwise', () => {
    expect(selfUpdateTurnedOff(false, {})).toBe(false);
    expect(selfUpdateTurnedOff(false, { SWITCH_CONTROLLER_SELF_UPDATE: 'on' })).toBe(false);
    expect(selfUpdateTurnedOff(false, { SWITCH_CONTROLLER_SELF_UPDATE: '' })).toBe(false);
    expect(selfUpdateTurnedOff(false, { SWITCH_CONTROLLER_SELF_UPDATE: 'off' })).toBe(true);
    expect(selfUpdateTurnedOff(false, { SWITCH_CONTROLLER_SELF_UPDATE: ' OFF ' })).toBe(true);
    expect(selfUpdateTurnedOff(true, {})).toBe(true);
  });

  it('fails loud on a value it does not know', () => {
    expect(() => selfUpdateTurnedOff(false, { SWITCH_CONTROLLER_SELF_UPDATE: 'no' })).toThrow(
      ConfigurationError
    );
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
      '--ignore-scripts',
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
      [
        'install',
        '--global',
        '--ignore-scripts',
        '--prefix',
        prefix,
        join(dir, 'package-0.31.0.tgz'),
      ],
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

  it('with self-update turned off, installs nothing and says so', async () => {
    const { self, downloads } = updater({ installer: unavailableInstaller(SELF_UPDATE_OFF) });
    const idle = host();
    await self.offer(named, idle.lent);
    expect(downloads).toEqual([]);
    expect(idle.restarts()).toBe(0);
    expect(self.status()).toEqual({
      target: '0.31.0',
      state: 'failed',
      problem: expect.stringMatching(
        /Self-update is turned off .*SWITCH_CONTROLLER_SELF_UPDATE=off/
      ),
    });
  });

  it('reports a release whose signature does not verify as failed, and does not install it', async () => {
    const { installer, calls } = recordingInstaller();
    const { self } = updater({
      installer,
      download: async () => {
        throw new Error('The release signature does not verify switch-agent-controller 0.31.0.');
      },
    });
    const idle = host();
    await self.offer(named, idle.lent);
    expect(calls).toEqual([]);
    expect(idle.restarts()).toBe(0);
    expect(self.status()).toEqual({
      target: '0.31.0',
      state: 'failed',
      problem: 'The release signature does not verify switch-agent-controller 0.31.0.',
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
