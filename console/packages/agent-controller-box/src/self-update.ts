import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { z } from 'zod';
import type { Fetch } from './api';
import { ConfigurationError } from './errors';
import { errorMessage, type Logger } from './log';
import type { TrustedReleaseKey } from './release-keys';
import { assertTrustedKeys, verifyDownloadedRelease } from './release-signing';
import { pointCurrent, prefixBin, pruneReleases, readCurrent } from './releases';
import { RELEASE_VERSION } from './update';

/**
 * Updating this controller to the release Switch names in its status
 * responses (`controller_release`): fetched over https, checked against the
 * SHA-256 Switch gave and against the release signature, which only a key built
 * into this controller (`release-keys.ts`) can make, installed with no install
 * scripts run, then switched to by exiting with `EXIT_RESTARTING`
 * for the service to start it again. Only while no session is in the middle
 * of a turn: idle sessions are restarted with it and resume their
 * conversations.
 */

/** The largest package a download is allowed to be. */
export const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;
/** How long a failed attempt at one release keeps another from starting. */
export const RETRY_AFTER_MS = 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PROBLEM = 500;

/** Turns following the release Switch names off on this machine: `off`, or `on` (the default). */
export const SELF_UPDATE_ENV = 'SWITCH_CONTROLLER_SELF_UPDATE';

/**
 * Whether self-update is turned off, by `--no-self-update` or
 * `SWITCH_CONTROLLER_SELF_UPDATE=off` (from the environment or the env file);
 * any other value of it than `on` or `off` is a configuration error.
 */
export function selfUpdateTurnedOff(flag: boolean, env: NodeJS.ProcessEnv): boolean {
  const value = env[SELF_UPDATE_ENV]?.trim().toLowerCase();
  if (value !== undefined && value !== '' && value !== 'on' && value !== 'off')
    throw new ConfigurationError(
      `${SELF_UPDATE_ENV} must be on or off, not '${env[SELF_UPDATE_ENV]}'.`
    );
  return flag || value === 'off';
}

/** What a controller with self-update turned off reports when Switch names another release. */
export const SELF_UPDATE_OFF = `Self-update is turned off on this machine (${SELF_UPDATE_ENV}=off or --no-self-update); install releases by hand (switch-agent-controller update), or turn it back on.`;

/** The release Switch names for this controller. */
export type ControllerReleaseTarget = { version: string; url: string; sha256: string };

const controllerReleaseSchema = z.object({
  version: z.string().regex(RELEASE_VERSION, 'must be x.y.z or x.y.z-<prerelease>'),
  url: z.url({ protocol: /^https$/ }),
  sha256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex digits')
    .transform((value) => value.toLowerCase()),
});

/**
 * `controller_release` as a status response carries it: absent or null when
 * Switch manages no release for this controller. One that cannot be read is
 * treated as none, with the reason.
 */
export function readControllerRelease(raw: unknown): {
  release: ControllerReleaseTarget | null;
  problem: string | null;
} {
  if (raw === undefined || raw === null) return { release: null, problem: null };
  const parsed = controllerReleaseSchema.safeParse(raw);
  if (parsed.success) return { release: parsed.data, problem: null };
  return {
    release: null,
    problem: parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'controller_release'}: ${issue.message}`)
      .join('; '),
  };
}

/** Fetches `url` into a new file in `dir`, refusing more than `maxBytes`; the file and its SHA-256. */
export async function downloadPackage(input: {
  fetch: Fetch;
  url: string;
  dir: string;
  maxBytes: number;
  signal: AbortSignal | null;
}): Promise<{ file: string; sha256: string }> {
  if (new URL(input.url).protocol !== 'https:')
    throw new Error(`A controller package is downloaded over https only, not from ${input.url}.`);
  await mkdir(input.dir, { recursive: true, mode: 0o700 });
  const signals = [
    AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    ...(input.signal ? [input.signal] : []),
  ];
  const response = await input.fetch(input.url, { signal: AbortSignal.any(signals) });
  if (!response.ok || !response.body)
    throw new Error(`Downloading ${input.url} answered ${response.status}.`);
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > input.maxBytes) {
    await response.body.cancel();
    throw new Error(
      `${input.url} is ${declared} bytes, more than the ${input.maxBytes} a controller package may be.`
    );
  }
  const file = join(input.dir, `switch-agent-controller-${randomUUID()}.tgz`);
  const handle = await open(file, 'wx', 0o600);
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > input.maxBytes)
        throw new Error(
          `${input.url} sent more than the ${input.maxBytes} bytes a controller package may be.`
        );
      hash.update(chunk);
      await handle.write(chunk);
    }
  } catch (error) {
    await handle.close();
    await rm(file, { force: true });
    throw error;
  }
  await handle.close();
  return { file, sha256: hash.digest('hex') };
}

/**
 * Fetches the release into `dir`, checks it against the SHA-256 Switch gave,
 * then checks the signature published beside it (`<url>.sig`) against `keys`
 * for that version and SHA-256: a file that fails either is deleted. With no
 * trusted key, nothing is downloaded.
 */
export async function downloadVerified(input: {
  fetch: Fetch;
  release: ControllerReleaseTarget;
  keys: readonly TrustedReleaseKey[];
  dir: string;
  maxBytes: number;
  signal: AbortSignal | null;
}): Promise<string> {
  assertTrustedKeys(input.keys);
  const { file, sha256 } = await downloadPackage({ ...input, url: input.release.url });
  if (sha256 !== input.release.sha256) {
    await rm(file, { force: true });
    throw new Error(
      `The package at ${input.release.url} has SHA-256 ${sha256}, not the ${input.release.sha256} Switch named; it was deleted.`
    );
  }
  await verifyDownloadedRelease({
    fetch: input.fetch,
    file,
    url: input.release.url,
    version: input.release.version,
    sha256,
    keys: input.keys,
    signal: input.signal,
  });
  return file;
}

/** Runs a command to completion with its own environment; rejects with its stderr when it fails. */
export type InstallRunner = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; signal: AbortSignal | null }
) => Promise<{ stdout: string }>;

export const runInstallCommand: InstallRunner = (file, args, options) =>
  new Promise((done, fail) => {
    execFile(
      file,
      args,
      {
        env: options.env,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const said = stderr.trim().split('\n').slice(-5).join('\n');
          fail(new Error(`${file} ${args.join(' ')} failed: ${said || error.message}`));
          return;
        }
        done({ stdout });
      }
    );
  });

/** How npm is run to install a release: beside `node`, on a PATH that finds that `node` first. */
export type NpmSetup = {
  run: InstallRunner;
  node: string;
  /** npm's cache, in a directory the controller owns. */
  cacheDir: string;
  env: NodeJS.ProcessEnv;
};

function npmCommand(setup: NpmSetup): { file: string; env: NodeJS.ProcessEnv } {
  const beside = join(dirname(setup.node), 'npm');
  return {
    file: existsSync(beside) ? beside : 'npm',
    env: {
      ...setup.env,
      PATH: [dirname(setup.node), setup.env.PATH ?? ''].filter(Boolean).join(delimiter),
      npm_config_cache: setup.cacheDir,
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      // Agents running as users of their own read the shared-host bundle installed.
      npm_config_umask: '0022',
    },
  };
}

/**
 * `npm install --global --ignore-scripts --prefix <prefix> <file>`: the
 * package from the local file, never a URL, with no lifecycle script run. With
 * no prefix, into npm's own global one.
 */
export async function npmInstall(
  setup: NpmSetup,
  prefix: string | null,
  file: string,
  signal: AbortSignal | null
): Promise<void> {
  const npm = npmCommand(setup);
  await setup.run(
    npm.file,
    ['install', '--global', '--ignore-scripts', ...(prefix ? ['--prefix', prefix] : []), file],
    {
      env: npm.env,
      signal,
    }
  );
}

/** Runs the CLI at `cli` with `--version`; it must say exactly `version`. */
export async function assertCliVersion(
  setup: NpmSetup,
  cli: string,
  version: string
): Promise<void> {
  const { stdout } = await setup.run(setup.node, [cli, '--version'], {
    env: npmCommand(setup).env,
    signal: null,
  });
  const said = stdout.trim();
  if (said !== version)
    throw new Error(`The installed controller says it is ${said || 'nothing'}, not ${version}.`);
}

/**
 * Installs a downloaded release. `prepare` readies it without changing what
 * runs; `activate` makes it what the next start runs.
 */
export type ReleaseInstaller = {
  /** Why this controller cannot install a release for itself; null when it can. */
  readonly unavailable: string | null;
  prepare(version: string, file: string, signal: AbortSignal | null): Promise<void>;
  activate(version: string, file: string): Promise<void>;
};

export function unavailableInstaller(reason: string): ReleaseInstaller {
  const refuse = async () => {
    throw new Error(reason);
  };
  return { unavailable: reason, prepare: refuse, activate: refuse };
}

/**
 * Installs into the npm prefix the running controller came from, over it, as
 * `update` does: a user's service, or a plain install.
 */
export class PrefixInstaller implements ReleaseInstaller {
  readonly unavailable = null;

  constructor(private readonly deps: { npm: NpmSetup; prefix: string; cli: string }) {}

  async prepare(): Promise<void> {}

  async activate(version: string, file: string): Promise<void> {
    await npmInstall(this.deps.npm, this.deps.prefix, file, null);
    await assertCliVersion(this.deps.npm, this.deps.cli, version);
  }
}

/**
 * Installs into a releases directory (`releases.ts`): into
 * `<version>.partial`, checked, renamed to `<version>`, then `current` is
 * pointed at it and older releases are pruned.
 */
export class ReleasesDirInstaller implements ReleaseInstaller {
  readonly unavailable = null;

  constructor(private readonly deps: { npm: NpmSetup; releasesDir: string }) {}

  async prepare(version: string, file: string, signal: AbortSignal | null): Promise<void> {
    const partial = join(this.deps.releasesDir, `${version}.partial`);
    const final = join(this.deps.releasesDir, version);
    await rm(partial, { recursive: true, force: true });
    try {
      await npmInstall(this.deps.npm, partial, file, signal);
      await assertCliVersion(this.deps.npm, prefixBin(partial), version);
    } catch (error) {
      await rm(partial, { recursive: true, force: true });
      throw error;
    }
    if (await exists(final)) {
      const replaced = `${final}.replaced-${randomUUID()}`;
      await rename(final, replaced);
      await rename(partial, final);
      await rm(replaced, { recursive: true, force: true });
    } else await rename(partial, final);
  }

  async activate(version: string): Promise<void> {
    const before = await readCurrent(this.deps.releasesDir);
    const target = join(this.deps.releasesDir, version);
    await pointCurrent(this.deps.releasesDir, target, null);
    await pruneReleases(this.deps.releasesDir, [
      target,
      ...(before.kind === 'link' ? [before.target] : []),
    ]);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** What the controller reports about an update it has not made (`update` in its status). */
export type UpdateReport = {
  target: string;
  state: 'waiting_idle' | 'failed' | 'restart_needed';
  problem?: string;
};

/** The last attempt at a release, kept across restarts so a failing one is not retried at each start. */
export type UpdateAttempt = { target: string; at: number; problem: string | null };

export type SelfUpdaterDeps = {
  version: string;
  installer: ReleaseInstaller;
  /** Fetches the release and checks it; the verified file, which the updater deletes. */
  download: (release: ControllerReleaseTarget, signal: AbortSignal) => Promise<string>;
  attempts: { last(): UpdateAttempt | null; save(attempt: UpdateAttempt | null): void };
  /** Whether exiting with `EXIT_RESTARTING` brings the controller back, as a service does. */
  supervised: boolean;
  log: Logger;
  now: () => number;
};

/** What the running controller lends the updater for one offer. */
export type UpdateHost = {
  /** Whether no session here is in the middle of a turn now. */
  idle: () => Promise<boolean>;
  /** Ends the controller with `restarting`. */
  restart: () => void;
  /** The controller stopping. */
  signal: AbortSignal;
};

/**
 * Follows the release Switch names: a version other than this one (newer or
 * older, so Switch can roll back) is installed while no session is mid-turn, and
 * the controller restarts into it. A failed attempt is not repeated for an
 * hour; what stands in the way is reported (`status()`).
 */
export class SelfUpdater {
  private report: UpdateReport | null = null;
  private running: Promise<void> | null = null;
  private lastLogged: string | null = null;

  constructor(private readonly deps: SelfUpdaterDeps) {}

  status(): UpdateReport | null {
    return this.report;
  }

  /** Considers what a status response named; one offer at a time, the others are dropped. */
  offer(raw: unknown, host: UpdateHost): Promise<void> {
    if (this.running) return this.running;
    this.running = this.consider(raw, host)
      .catch((error: unknown) => {
        this.deps.log.error('Following the release Switch names failed', {
          error: errorMessage(error),
        });
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** Resolves once no offer is being worked on. */
  async settled(): Promise<void> {
    await this.running;
  }

  private async consider(raw: unknown, host: UpdateHost): Promise<void> {
    const { log, version, installer } = this.deps;
    const { release, problem } = readControllerRelease(raw);
    if (problem)
      this.logOnce(`malformed:${problem}`, () =>
        log.warn('Switch named a controller release this controller cannot read; ignoring it', {
          problem,
        })
      );
    if (!release || release.version === version) {
      this.report = null;
      this.lastLogged = null;
      return;
    }
    const target = release.version;
    if (this.report?.target === target && this.report.state === 'restart_needed') return;
    if (installer.unavailable) {
      this.fail(target, installer.unavailable, false);
      return;
    }
    const last = this.deps.attempts.last();
    if (last && last.target === target && this.deps.now() - last.at < RETRY_AFTER_MS) {
      this.fail(
        target,
        last.problem ??
          `An attempt at ${target} at ${new Date(last.at).toISOString()} did not finish, or restarted into it and still ran ${version}.`,
        true
      );
      return;
    }
    if (!(await host.idle())) return this.waitForIdle(target);
    if (host.signal.aborted) return;
    log.info('Updating this controller to the release Switch names', { from: version, to: target });
    const at = this.deps.now();
    this.deps.attempts.save({ target, at, problem: null });
    let file: string | null = null;
    try {
      file = await this.deps.download(release, host.signal);
      await installer.prepare(target, file, host.signal);
      if (host.signal.aborted) {
        this.deps.attempts.save(null);
        return;
      }
      if (!(await host.idle())) {
        this.deps.attempts.save(null);
        return this.waitForIdle(target);
      }
      await installer.activate(target, file);
    } catch (error) {
      if (host.signal.aborted) {
        this.deps.attempts.save(null);
        return;
      }
      const problem = errorMessage(error).slice(0, MAX_PROBLEM);
      this.deps.attempts.save({ target, at, problem });
      this.fail(target, problem, true);
      return;
    } finally {
      if (file) await rm(file, { force: true });
    }
    if (this.deps.supervised) {
      log.info('Installed the release Switch names; restarting into it', { version: target });
      this.report = null;
      host.restart();
      return;
    }
    this.report = {
      target,
      state: 'restart_needed',
      problem: `Installed ${target}; this controller runs outside a service, so it runs ${version} until it is restarted.`,
    };
    log.warn(
      `Installed switch-agent-controller ${target}, the release Switch names; restart this controller to run it (it runs ${version}).`
    );
  }

  private waitForIdle(target: string): void {
    this.report = { target, state: 'waiting_idle' };
    this.logOnce(`waiting:${target}`, () =>
      this.deps.log.info(
        'Switch names another controller release; it is installed once no session is mid-turn',
        {
          from: this.deps.version,
          to: target,
        }
      )
    );
  }

  private fail(target: string, problem: string, retrying: boolean): void {
    this.report = { target, state: 'failed', problem: problem.slice(0, MAX_PROBLEM) };
    this.logOnce(`failed:${target}:${problem}`, () =>
      this.deps.log.warn(
        retrying
          ? 'This controller could not update to the release Switch names; it tries again in an hour'
          : 'This controller cannot update itself to the release Switch names',
        { from: this.deps.version, to: target, problem }
      )
    );
  }

  private logOnce(key: string, write: () => void): void {
    if (this.lastLogged === key) return;
    this.lastLogged = key;
    write();
  }
}
