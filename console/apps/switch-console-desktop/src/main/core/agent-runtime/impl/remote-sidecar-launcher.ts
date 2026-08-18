import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ContractRange } from '@switch-console/shared';
import { exactTmuxTarget } from '@main/core/pty/tmux-session-name';
import { quoteShellArg } from '@main/utils/shellEscape';
import type { AgentLaunchSpec } from '../../../../sidecar/agent-launch-spec';
import {
  SIDECAR_BUNDLE_REL_PATH,
  sidecarAgentDir,
  sidecarDeployLockRelPath,
  sidecarLaunchSpecRelPath,
  sidecarEndpointRelPath,
  sidecarLogRelPath,
  sidecarReadyRelPath,
  sidecarStateRelPath,
  sidecarWatchEnabledRelPath,
} from '../../../../sidecar/sidecar-paths';
import {
  compareSidecarVersions,
  MIN_SUPPORTED_SIDECAR_MAJOR,
  SIDECAR_CLIENT_MAJOR,
  SIDECAR_VERSION,
  sidecarMajor,
} from '../../../../sidecar/sidecar-version';

/**
 * Deploys and launches the Switch Console remote runtime sidecar on the agent's VM
 * (CHOO-1059 → CHOO-1085), then waits for it to report a ready endpoint.
 *
 * The sidecar is agent-scoped: one per remote agent, serving every session on
 * the VM (the one Switch Console starts over SSH and any it auto-starts) plus the
 * notification watcher. It must outlive the Switch Console UI — that is the whole
 * point — so it runs inside its own detached tmux session rather than on the
 * launching SSH channel (which dies when Switch Console disconnects). It writes
 * `{event:"ready",port,token,hash,epoch,pid}` to its ready file atomically once
 * bound; the launcher polls that file until a line from the incarnation it just
 * started appears, then returns the endpoint so the caller can point its remote
 * sessions' hook env at the VM-local server. The ready line also carries the
 * sidecar's `version` (human-readable `x.y`), its build `hash`, and the
 * `deployer` identity of the install that started it.
 *
 * Replacing a running sidecar is serialised across clients by a host-side deploy
 * lock: two clients deploying at once would overwrite the bundle under each
 * other and each kill the other's freshly started process.
 */

const SIDECAR_TMUX_SUFFIX = '-sidecar';
const AGENT_SIDECAR_TMUX_PREFIX = 'switchdash-sidecar-';
const READY_POLL_INTERVAL_MS = 250;
const READY_MAX_ATTEMPTS = 80; // ~20s
const DEPLOY_LOCK_POLL_MS = 500;
const DEPLOY_LOCK_MAX_ATTEMPTS = 60; // ~30s waiting on another client's deploy
/** `find -mmin` granularity is minutes; 2 comfortably exceeds a real deploy. */
const DEPLOY_LOCK_STALE_MIN = 2;
/** Trim the append-only sidecar log at launch once it passes this size. */
const SIDECAR_LOG_MAX_BYTES = 8 * 1024 * 1024;
const SIDECAR_LOG_KEEP_BYTES = 1024 * 1024;

export interface SidecarLaunchConfig {
  /** Absolute remote repo dir; the bundle, spec, ready file, and log live under .switchdash/. */
  repoDir: string;
  deeplinkScheme: string;
  /** Provider-specific launch recipe the sidecar's watcher materialises per auto-start. */
  launchSpec: AgentLaunchSpec;
  /** The agent's per-agent credentials slug — its definition name, else its agent
   * id — so the sidecar reads `.switch/agents/<slug>.json` for this agent's Switch
   * identity rather than the legacy shared settings file (CHOO-1440). */
  credsSlug: string;
  /** This Switch Console install's deployer identity, stamped on whatever sidecar
   * it starts so another install can tell that build apart from its own without
   * relying on the version string. */
  deployerId: string;
}

export interface SidecarEndpoint {
  port: number;
  token: string;
  /** Absolute on-VM path of the sidecar's endpoint file. Sessions are launched
   * pointing at this rather than at `port`/`token` directly, so they survive the
   * sidecar restarting on a fresh port with a fresh token. */
  endpointFile: string;
}

/** The ready line the sidecar prints. `hash` is absent for a pre-CHOO-1085
 * sidecar; the endpoint file path is derived locally, not carried on the wire. */
interface ReadyLine {
  port: number;
  token: string;
  hash: string | null;
  /** Monotonic per-start counter from the sidecar's durable state. Absent from
   * a pre-CHOO-1425 sidecar. */
  epoch: number | null;
  /** Release version, `MAJOR.MINOR.PATCH`. Says which release is running and
   * nothing about compatibility — that is `contract`. Absent from a sidecar
   * predating versioning, which is treated as major 0. */
  version: string | null;
  /** What the running sidecar says it speaks on `sidecar-control` (CHOO-1865).
   * Null for a sidecar deployed before it declared anything, which means
   * *unknown* — never agreement. Recorded, not yet acted on. */
  contract: ContractRange | null;
  /** OS process id of the running sidecar, for display. Absent from an older one. */
  pid: number | null;
  /** Which Switch Console install deployed this sidecar. Null for one deployed
   * before installs identified themselves, which means *unknown* — never "mine". */
  deployer: string | null;
}

/**
 * Read-only view of the sidecar running on the host, for the UI. Independent of
 * whether this client's bundle matches — that comparison (the verdict) is the
 * caller's to make, since it needs the client's own hash and version.
 */
export interface SidecarRunStatus {
  running: boolean;
  /** Whether this client can speak to it (its major is in the supported range). */
  compatible: boolean;
  /** Build fingerprint the running sidecar reports for itself. */
  hash: string | null;
  /** Release version the running sidecar reports, `MAJOR.MINOR.PATCH`. */
  version: string | null;
  /** The `sidecar-control` range it declared, or null for unknown (CHOO-1865).
   * Null must render as unknown, never as compatible. */
  contract: ContractRange | null;
  epoch: number | null;
  pid: number | null;
  /** The install that deployed it, or null when it predates deployer identity.
   * Null must read as unknown, never as this install. */
  deployerId: string | null;
  /** Sessions the running sidecar currently owns, from its durable state. */
  liveSessions: number;
}

/** Narrow remote seam the launcher needs — satisfied by IExecutionContext + ssh-fs. */
export interface SidecarHost {
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
  putFile(localAbsPath: string, remoteRelPath: string): Promise<void>;
}

export interface SidecarLauncherLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

function sidecarEnv(config: SidecarLaunchConfig): Record<string, string> {
  return {
    SWITCHDASH_SIDECAR_REPO_DIR: config.repoDir,
    SWITCHDASH_SIDECAR_DEEPLINK_SCHEME: config.deeplinkScheme,
    SWITCHDASH_SIDECAR_AGENT_SLUG: config.credsSlug,
    SWITCHDASH_SIDECAR_DEPLOYER_ID: config.deployerId,
  };
}

function parseReady(raw: string): ReadyLine | null {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'event' in parsed &&
    parsed.event === 'ready' &&
    'port' in parsed &&
    typeof parsed.port === 'number' &&
    'token' in parsed &&
    typeof parsed.token === 'string'
  ) {
    const hash = 'hash' in parsed && typeof parsed.hash === 'string' ? parsed.hash : null;
    const epoch = 'epoch' in parsed && typeof parsed.epoch === 'number' ? parsed.epoch : null;
    const version =
      'version' in parsed && typeof parsed.version === 'string' ? parsed.version : null;
    const pid = 'pid' in parsed && typeof parsed.pid === 'number' ? parsed.pid : null;
    const deployer =
      'deployer' in parsed && typeof parsed.deployer === 'string' && parsed.deployer
        ? parsed.deployer
        : null;
    return {
      port: parsed.port,
      token: parsed.token,
      hash,
      epoch,
      version,
      contract: parseContract(parsed),
      pid,
      deployer,
    };
  }
  return null;
}

/**
 * The `sidecar-control` range a sidecar declared, or null for unknown.
 *
 * A partial or malformed declaration reads as unknown rather than as the half
 * that parsed: half a range is not a range, and guessing the other half would
 * invent a number nobody declared.
 */
function parseContract(parsed: object): ContractRange | null {
  if (!('contract' in parsed)) return null;
  const contract = parsed.contract;
  if (typeof contract !== 'object' || contract === null) return null;
  if (!('speaks' in contract) || !('accepts' in contract)) return null;
  const { speaks, accepts } = contract as { speaks: unknown; accepts: unknown };
  if (typeof speaks !== 'number' || typeof accepts !== 'number') return null;
  if (!Number.isInteger(speaks) || !Number.isInteger(accepts)) return null;
  return { speaks, accepts };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deterministic, agent-scoped tmux session name for the sidecar, derived from
 * the remote repo dir AND the agent's creds slug — so every caller (the SSH
 * agent runtime and the auto-session setup path) computes the same name and
 * reattaches to that agent's sidecar, while two agents sharing a directory get
 * distinct sidecars (CHOO-1440). Deliberately does NOT end in `-sidecar` so the
 * legacy per-session `reapOrphanedSidecars` never mistakes it for an orphan.
 */
export function agentSidecarTmuxName(repoDir: string, slug: string): string {
  const hash = createHash('sha256').update(`${repoDir}\0${slug}`).digest('hex').slice(0, 16);
  return `${AGENT_SIDECAR_TMUX_PREFIX}${hash}`;
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

export class RemoteSidecarLauncher {
  private readonly host: SidecarHost;
  private readonly bundlePath: string;
  private readonly sidecarTmuxName: string;
  private readonly config: SidecarLaunchConfig;
  private readonly log: SidecarLauncherLogger;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Step currently being attempted, reported when a launch fails. */
  private stage = 'idle';

  private readonly hashBundle: () => Promise<string>;

  constructor(opts: {
    host: SidecarHost;
    /** Local absolute path to the built sidecar bundle (dist-sidecar/sidecar.mjs). */
    bundlePath: string;
    /** Dedicated tmux session that keeps the sidecar alive across UI disconnects. */
    sidecarTmuxName: string;
    config: SidecarLaunchConfig;
    log: SidecarLauncherLogger;
    sleep?: (ms: number) => Promise<void>;
    /** Override the local bundle hash (tests); defaults to sha256 of bundlePath. */
    hashBundle?: () => Promise<string>;
  }) {
    this.host = opts.host;
    this.bundlePath = opts.bundlePath;
    this.sidecarTmuxName = opts.sidecarTmuxName;
    this.config = opts.config;
    this.log = opts.log;
    this.sleep = opts.sleep ?? defaultSleep;
    this.hashBundle = opts.hashBundle ?? (() => sha256File(this.bundlePath));
  }

  /** Per-agent state paths, keyed by this agent's creds slug (CHOO-1440). */
  private get agentDir(): string {
    return sidecarAgentDir(this.config.credsSlug);
  }
  private get launchSpecPath(): string {
    return sidecarLaunchSpecRelPath(this.config.credsSlug);
  }
  private get readyPath(): string {
    return sidecarReadyRelPath(this.config.credsSlug);
  }
  private get logPath(): string {
    return sidecarLogRelPath(this.config.credsSlug);
  }
  private get statePath(): string {
    return sidecarStateRelPath(this.config.credsSlug);
  }
  private get deployLockPath(): string {
    return sidecarDeployLockRelPath(this.config.credsSlug);
  }
  /** Absolute, because it is baked into spawned sessions' env and read by hooks
   * whose working directory is not guaranteed to be the repo dir. */
  private get endpointFile(): string {
    return `${this.config.repoDir}/${sidecarEndpointRelPath(this.config.credsSlug)}`;
  }

  private toEndpoint(ready: ReadyLine): SidecarEndpoint {
    return { port: ready.port, token: ready.token, endpointFile: this.endpointFile };
  }

  /**
   * Reconcile-or-launch. The sidecar is designed to outlive the Switch Console UI,
   * so on relaunch a still-running sidecar (its tmux session alive and its ready
   * file intact) is reattached to rather than redeployed — preserving its poll
   * queue and connection. Only when none is running (or it's stale) do we deploy
   * the bundle and start fresh.
   */
  async deployAndLaunch(): Promise<SidecarEndpoint> {
    const startedAt = Date.now();
    // Which step was reached is the whole diagnosis here: an SSH auth refusal
    // and a ready-file timeout are unrelated faults with unrelated fixes, and
    // a single "sidecar launch failed" cannot tell them apart.
    this.stage = 'launch-spec';

    try {
      const endpoint = await this.runDeployAndLaunch();
      this.log.debug('RemoteSidecarLauncher: launch succeeded', {
        event: 'sidecar_launch_succeeded',
        durationMs: Date.now() - startedAt,
        sidecarTmuxName: this.sidecarTmuxName,
      });
      return endpoint;
    } catch (error) {
      this.log.error('RemoteSidecarLauncher: launch failed', {
        event: 'sidecar_launch_failed',
        stage: this.stage,
        durationMs: Date.now() - startedAt,
        sidecarTmuxName: this.sidecarTmuxName,
        agentSlug: this.config.credsSlug,
        error: String(error),
      });
      throw error;
    }
  }

  private async runDeployAndLaunch(): Promise<SidecarEndpoint> {
    // Always (re)write the launch spec first so a config change (e.g. new extra
    // args) takes effect on the next fresh launch, even when reattaching.
    await this.writeLaunchSpec();

    this.stage = 'hash-bundle';
    const localHash = await this.hashBundle();
    this.stage = 'reattach-check';
    const existing = await this.decideExisting(localHash);
    if (existing) {
      this.log.debug('RemoteSidecarLauncher: reattached to running sidecar', {
        sidecarTmuxName: this.sidecarTmuxName,
        port: existing.port,
      });
      return existing;
    }

    // Replacing the sidecar is not safe to do concurrently: two clients would
    // overwrite the bundle under each other and each kill the other's freshly
    // started process. Serialise it across clients, then re-check — whoever
    // waited may find the holder already started exactly what it wanted.
    this.stage = 'deploy-lock';
    return this.withDeployLock(async () => {
      const reattach = await this.decideExisting(localHash);
      if (reattach) {
        this.log.debug('RemoteSidecarLauncher: another client deployed a matching sidecar', {
          sidecarTmuxName: this.sidecarTmuxName,
          port: reattach.port,
        });
        return reattach;
      }

      const previousEpoch = await this.runningEpoch();
      this.stage = 'prepare-dir';
      const remoteHash = await this.prepareDir();
      if (remoteHash === localHash) {
        this.log.debug('RemoteSidecarLauncher: bundle unchanged on host — skipping upload', {
          sidecarTmuxName: this.sidecarTmuxName,
        });
      } else {
        this.stage = 'upload-bundle';
        await this.uploadBundle();
      }
      this.stage = 'kill-previous';
      await this.killSidecar();
      this.stage = 'spawn';
      await this.startDetached(localHash);
      this.stage = 'await-ready';
      return this.awaitReady(previousEpoch);
    });
  }

  /**
   * Create the sidecar dir and return the hash of the bundle already on the
   * host (empty when absent), so the 1.2MB SFTP is skipped whenever an identical
   * copy is already deployed (the common case: a new session reusing a prior
   * session's bundle).
   *
   * The hash is computed from the file itself rather than read from a sidecar
   * file kept alongside it: that file could be torn, written out of step with
   * the bundle, or simply stale, each of which silently defeats the comparison.
   *
   * Note this no longer deletes the ready file. Doing so made a healthy running
   * sidecar undiscoverable to every other client for the duration of a deploy —
   * and permanently if the deploy then failed. The sidecar replaces that file
   * atomically when it starts.
   */
  private async prepareDir(): Promise<string> {
    const bundle = quoteShellArg(SIDECAR_BUNDLE_REL_PATH);
    const script = [
      `mkdir -p ${quoteShellArg(this.agentDir)}`,
      `if [ -f ${bundle} ]; then sha256sum ${bundle} 2>/dev/null || shasum -a 256 ${bundle} 2>/dev/null; fi`,
    ].join('; ');
    const { stdout } = await this.host.exec('sh', ['-c', script]);
    return stdout.trim().split(/\s+/)[0] ?? '';
  }

  /**
   * Upload the bundle to a temp path and rename it into place.
   *
   * `putFile` is a direct SFTP overwrite: it truncates the destination and
   * streams into it, so for the length of the transfer the file node is about
   * to load is observably half-written. A concurrent start would fail on a
   * SyntaxError. Renaming is atomic, so a reader sees the old bundle or the new
   * one.
   *
   * The temp name must be unique across *machines*, not just within one: the
   * deploy lock is per-agent while the bundle is shared per directory, so two
   * clients deploying for different agents in one directory hold different locks
   * and upload concurrently. A pid alone collides across hosts, and two streams
   * into one temp file rename a torn bundle into place (CHOO-1937).
   */
  private async uploadBundle(): Promise<void> {
    const tmpRel = `${SIDECAR_BUNDLE_REL_PATH}.${randomUUID()}.tmp`;
    try {
      await this.host.putFile(this.bundlePath, tmpRel);
      await this.host.exec('sh', [
        '-c',
        `mv ${quoteShellArg(tmpRel)} ${quoteShellArg(SIDECAR_BUNDLE_REL_PATH)}`,
      ]);
    } catch (error) {
      // A unique name is never reused, so a failed attempt can no longer be
      // cleaned up by the next one overwriting it. Remove it here instead of
      // accumulating fragments in a directory other clients deploy into too.
      await this.host.exec('sh', ['-c', `rm -f ${quoteShellArg(tmpRel)}`]).catch((cause: unknown) =>
        this.log.debug('RemoteSidecarLauncher: could not remove a failed bundle upload', {
          tmpRel,
          error: String(cause),
        })
      );
      throw error;
    }
  }

  /** Epoch of the sidecar currently running, or null if none/unreadable. */
  private async runningEpoch(): Promise<number | null> {
    const raw = await this.readReadyFile();
    return (raw ? parseReady(raw) : null)?.epoch ?? null;
  }

  /**
   * Run `fn` holding the host-side deploy lock for this agent.
   *
   * `mkdir` is atomic on POSIX — it fails if the directory exists — which makes
   * it a usable mutex over plain ssh, unlike a create-then-write lockfile. A
   * lock older than the timeout is broken rather than honoured: the holder may
   * have been killed mid-deploy, and refusing to ever deploy again would be a
   * worse failure than the race the lock prevents.
   */
  private async withDeployLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = quoteShellArg(this.deployLockPath);
    for (let attempt = 0; attempt < DEPLOY_LOCK_MAX_ATTEMPTS; attempt++) {
      const { stdout } = await this.host.exec('sh', [
        '-c',
        `if mkdir ${lock} 2>/dev/null; then echo acquired; else ` +
          // Break a stale lock: find returns the dir only when it is older than
          // the staleness window, so a live holder is left alone.
          `if [ -n "$(find ${lock} -maxdepth 0 -mmin +${DEPLOY_LOCK_STALE_MIN} 2>/dev/null)" ]; then ` +
          `rm -rf ${lock} && mkdir ${lock} 2>/dev/null && echo broke-stale; else echo busy; fi; fi`,
      ]);
      const outcome = stdout.trim();
      if (outcome === 'broke-stale') {
        this.log.warn('RemoteSidecarLauncher: broke a stale deploy lock', {
          sidecarTmuxName: this.sidecarTmuxName,
        });
      }
      if (outcome === 'acquired' || outcome === 'broke-stale') {
        try {
          return await fn();
        } finally {
          await this.host.exec('sh', ['-c', `rm -rf ${lock}`]).catch((error: unknown) =>
            this.log.warn('RemoteSidecarLauncher: failed to release deploy lock', {
              error: String(error),
            })
          );
        }
      }
      await this.sleep(DEPLOY_LOCK_POLL_MS);
    }
    throw new Error(
      `another client has been deploying this sidecar for over ` +
        `${(DEPLOY_LOCK_MAX_ATTEMPTS * DEPLOY_LOCK_POLL_MS) / 1000}s — not replacing it`
    );
  }

  private async writeLaunchSpec(): Promise<void> {
    const json = JSON.stringify(this.config.launchSpec);
    const b64 = Buffer.from(json, 'utf8').toString('base64');
    const spec = quoteShellArg(this.launchSpecPath);
    // base64 round-trip avoids fighting shell quoting on the JSON payload. Write
    // to a per-process temp (`$$`) then atomically `mv` into place, so nothing
    // can observe a torn, half-written spec that would crash the sidecar on
    // startup.
    await this.host.exec('sh', [
      '-c',
      `mkdir -p ${quoteShellArg(this.agentDir)} && tmp=${spec}.$$.tmp && printf %s ${quoteShellArg(b64)} | base64 -d > "$tmp" && mv "$tmp" ${spec}`,
    ]);
  }

  /**
   * Endpoint of an already-running sidecar for this session, or null. Reattaches
   * only when the running process was launched from the current bundle: its ready
   * line carries the bundle hash it started with, so a sidecar left over from an
   * older bundle (or a pre-CHOO-1085 one that reports no hash) is treated as stale
   * and relaunched — otherwise a bundle upgrade never takes effect while the old
   * process keeps running.
   */
  /** The running sidecar's ready line, or null when none is running. */
  private async readRunning(): Promise<ReadyLine | null> {
    try {
      await this.host.exec('tmux', ['has-session', '-t', exactTmuxTarget(this.sidecarTmuxName)]);
    } catch {
      return null; // not running
    }
    const raw = await this.readReadyFile();
    return raw ? parseReady(raw) : null;
  }

  /**
   * Whether this client can speak to the running sidecar at all.
   *
   * Deliberately independent of the bundle hash. A different build is not an
   * incompatibility — it only means an upgrade exists — and treating it as one
   * is what made two clients on different builds kill each other's sidecar in a
   * loop. A sidecar that reports no protocol predates the field and is treated
   * as version 0.
   */
  private isCompatible(ready: ReadyLine): boolean {
    const major = sidecarMajor(ready.version);
    return major >= MIN_SUPPORTED_SIDECAR_MAJOR && major <= SIDECAR_CLIENT_MAJOR;
  }

  /**
   * Endpoint of an already-running, *compatible* sidecar, or null if none is
   * running. Read-only — unlike `deployAndLaunch` it never deploys, writes, or
   * starts anything. For callers that only want to talk to a sidecar if one
   * exists (cross-client discovery), so a merely-configured agent does not cause
   * one to be launched.
   *
   * A running sidecar built from a different bundle is still returned: discovery
   * asks "can I talk to it", and answering that with the *upgrade* question made
   * every client on a different build report zero sessions and prune live rows.
   */
  /**
   * Read-only status of the sidecar on the host, for display. Never launches,
   * deploys, or writes. Returns `running: false` when none is up; otherwise the
   * running sidecar's self-reported identity plus its live-session count.
   *
   * The client-vs-host verdict is intentionally left to the caller — it needs
   * this client's own bundle hash and version, which the launcher exposes via
   * `localBundleHash()` and the shared version constant.
   */
  async readStatus(): Promise<SidecarRunStatus> {
    const ready = await this.readRunning();
    if (!ready) {
      return {
        running: false,
        compatible: false,
        hash: null,
        version: null,
        contract: null,
        epoch: null,
        pid: null,
        deployerId: null,
        liveSessions: 0,
      };
    }
    return {
      running: true,
      compatible: this.isCompatible(ready),
      hash: ready.hash,
      version: ready.version,
      contract: ready.contract,
      epoch: ready.epoch,
      pid: ready.pid,
      deployerId: ready.deployer,
      liveSessions: await this.runningSessionCount(),
    };
  }

  /** This client's own bundle fingerprint, for the caller to compare against
   * `readStatus().hash`. */
  localBundleHash(): Promise<string> {
    return this.hashBundle();
  }

  /** This install's deployer identity, for the caller to compare against
   * `readStatus().deployerId`. */
  localDeployerId(): string {
    return this.config.deployerId;
  }

  async probeExisting(): Promise<SidecarEndpoint | null> {
    const ready = await this.readRunning();
    if (!ready) return null;
    if (!this.isCompatible(ready)) {
      this.log.debug('RemoteSidecarLauncher: running sidecar speaks an unusable protocol', {
        sidecarTmuxName: this.sidecarTmuxName,
        runningVersion: ready.version,
        clientVersion: `${SIDECAR_CLIENT_MAJOR}.x`,
      });
      return null;
    }
    return this.toEndpoint(ready);
  }

  /**
   * Decide what to do about a sidecar that is already running.
   *
   * Replacing one is disruptive even now that sessions survive it, so it is
   * reserved for the cases that need it:
   *  - incompatible protocol → must replace; we cannot talk to it at all.
   *  - same build → reattach; there is nothing to gain.
   *  - newer version → reattach; a newer Switch Console deployed it, and replacing
   *    it would be a downgrade.
   *  - same version, another install's build → reattach; neither of us can claim
   *    to be the upgrade, so whoever got there first keeps it.
   *  - different build, no live sessions → upgrade, since nothing is disturbed.
   *  - different build, live sessions → reattach and record that an upgrade is
   *    pending, rather than interrupting work in flight for a build difference.
   *    The next launch with an idle sidecar picks it up.
   */
  private async decideExisting(localHash: string): Promise<SidecarEndpoint | null> {
    const ready = await this.readRunning();
    if (!ready) return null;

    if (!this.isCompatible(ready)) {
      this.log.warn('RemoteSidecarLauncher: replacing sidecar with an unusable protocol', {
        sidecarTmuxName: this.sidecarTmuxName,
        runningVersion: ready.version,
        clientVersion: `${SIDECAR_CLIENT_MAJOR}.x`,
      });
      return null;
    }
    if (ready.hash === localHash) return this.toEndpoint(ready);

    // A hash difference alone does not say which build is newer. On a host two
    // Switch Console installs share, replacing on difference alone means each sees
    // the other's sidecar as an upgrade and they trade it back and forth
    // indefinitely. Ordering by version breaks the symmetry: only the newer
    // client replaces, and the older one settles for what is already there
    // (CHOO-1937).
    if (compareSidecarVersions(ready.version, SIDECAR_VERSION) > 0) {
      this.log.debug('RemoteSidecarLauncher: host runs a newer sidecar — leaving it in place', {
        sidecarTmuxName: this.sidecarTmuxName,
        runningVersion: ready.version,
        clientVersion: SIDECAR_VERSION,
      });
      return this.toEndpoint(ready);
    }

    // Version ordering has nothing left to say once the versions are equal, and
    // that is the everyday case for two dev builds of one release: each install
    // reads the other's hash as an upgrade and they trade the sidecar back and
    // forth for as long as both are open. So when the build on the host is
    // another install's, yield to it — whoever deployed first keeps it, and the
    // operator's Restart is the way to take it over deliberately.
    //
    // Only ever replaces LESS than before: an older version is still replaced,
    // and an unidentified sidecar (deployed before this, or by our own install)
    // still is, so a single deploy ends the trading rather than nothing ever
    // being upgraded again.
    if (
      ready.deployer !== null &&
      ready.deployer !== this.config.deployerId &&
      compareSidecarVersions(ready.version, SIDECAR_VERSION) === 0
    ) {
      this.log.debug(
        'RemoteSidecarLauncher: another install deployed this sidecar at the same version — leaving it in place',
        {
          sidecarTmuxName: this.sidecarTmuxName,
          version: ready.version,
          runningHash: ready.hash,
          localHash,
        }
      );
      return this.toEndpoint(ready);
    }

    const liveSessions = await this.runningSessionCount();
    if (liveSessions > 0) {
      this.log.warn(
        'RemoteSidecarLauncher: sidecar upgrade pending — deferring while sessions run',
        {
          sidecarTmuxName: this.sidecarTmuxName,
          runningHash: ready.hash,
          localHash,
          liveSessions,
        }
      );
      return this.toEndpoint(ready);
    }
    this.log.debug('RemoteSidecarLauncher: upgrading idle sidecar to the current bundle', {
      sidecarTmuxName: this.sidecarTmuxName,
      runningHash: ready.hash,
      localHash,
    });
    return null;
  }

  /**
   * How many sessions the running sidecar currently owns, read from its durable
   * state. Zero when unreadable — an unparseable state file is not grounds for
   * refusing to upgrade forever.
   */
  private async runningSessionCount(): Promise<number> {
    try {
      const { stdout } = await this.host.exec('cat', [this.statePath]);
      const parsed = JSON.parse(stdout) as { sessions?: unknown };
      return Array.isArray(parsed.sessions) ? parsed.sessions.length : 0;
    } catch {
      return 0;
    }
  }

  async stop(): Promise<void> {
    await this.killSidecar();
  }

  private async killSidecar(): Promise<void> {
    try {
      await this.host.exec('tmux', ['kill-session', '-t', exactTmuxTarget(this.sidecarTmuxName)]);
    } catch (error) {
      this.log.debug('RemoteSidecarLauncher: no existing sidecar session to kill', {
        sidecarTmuxName: this.sidecarTmuxName,
        error: String(error),
      });
    }
  }

  private async startDetached(bundleHash: string): Promise<void> {
    const env = { ...sidecarEnv(this.config), SWITCHDASH_SIDECAR_BUNDLE_HASH: bundleHash };
    const envPrefix = Object.entries(env)
      .map(([key, value]) => `${key}=${quoteShellArg(value)}`)
      .join(' ');
    // Trim the log first: it is append-only for the life of the host, and the
    // sidecar logs a line per `/events` poll per attached client. Left alone it
    // eventually fills the disk, which then breaks the very files — ready,
    // endpoint, state — that everything else depends on. A restart is the
    // natural rotation point.
    const log = quoteShellArg(this.logPath);
    await this.host.exec('sh', [
      '-c',
      `if [ -f ${log} ] && [ "$(wc -c < ${log})" -gt ${SIDECAR_LOG_MAX_BYTES} ]; then ` +
        `tail -c ${SIDECAR_LOG_KEEP_BYTES} ${log} > ${log}.tmp && mv ${log}.tmp ${log}; fi`,
    ]);
    // stdout goes to the log alongside stderr; the sidecar writes its ready file
    // itself (atomically) rather than relying on a shell redirect, which would
    // truncate it the moment the process starts.
    const inner =
      `${envPrefix} exec node ${quoteShellArg(SIDECAR_BUNDLE_REL_PATH)} ` +
      `>> ${quoteShellArg(this.logPath)} 2>&1`;
    await this.host.exec('tmux', [
      'new-session',
      '-d',
      '-s',
      this.sidecarTmuxName,
      '-c',
      this.config.repoDir,
      inner,
    ]);
  }

  /**
   * Wait for the sidecar we just started to publish its endpoint.
   *
   * The ready file is no longer deleted before launch, so a leftover line from
   * the process we killed would otherwise be mistaken for the new one's. The
   * epoch increments on every start, so requiring a higher one identifies the
   * new incarnation. A sidecar that reports no epoch predates this and cannot
   * be distinguished — accept it rather than hang.
   */
  private async awaitReady(previousEpoch: number | null): Promise<SidecarEndpoint> {
    for (let attempt = 0; attempt < READY_MAX_ATTEMPTS; attempt++) {
      await this.assertAlive();
      const raw = await this.readReadyFile();
      const ready = raw ? parseReady(raw) : null;
      const isNew =
        ready && (previousEpoch === null || ready.epoch === null || ready.epoch > previousEpoch);
      if (ready && isNew) return this.toEndpoint(ready);
      await this.sleep(READY_POLL_INTERVAL_MS);
    }
    throw new Error(
      `sidecar did not report ready within ${
        (READY_MAX_ATTEMPTS * READY_POLL_INTERVAL_MS) / 1000
      }s — see ${this.config.repoDir}/${this.logPath}`
    );
  }

  private async assertAlive(): Promise<void> {
    try {
      await this.host.exec('tmux', ['has-session', '-t', exactTmuxTarget(this.sidecarTmuxName)]);
    } catch {
      const tail = await this.readLogTail();
      const logRef = `${this.config.repoDir}/${this.logPath}`;
      this.log.warn('RemoteSidecarLauncher: sidecar exited during startup', {
        sidecarTmuxName: this.sidecarTmuxName,
        logRef,
        logTail: tail,
      });
      throw new Error(
        tail
          ? `sidecar process exited during startup — last output from ${logRef}:\n${tail}`
          : `sidecar process exited during startup (no output in ${logRef})`
      );
    }
  }

  /** Best-effort tail of the sidecar log, so a startup crash surfaces its actual
   * error (e.g. a SyntaxError from too-old node) instead of an opaque message. */
  private async readLogTail(lines = 20): Promise<string> {
    try {
      const { stdout } = await this.host.exec('tail', ['-n', String(lines), this.logPath]);
      return stdout.trim();
    } catch {
      return '';
    }
  }

  /** Public log tail for the UI's debug panel. Best-effort — empty on any error. */
  logTail(lines: number): Promise<string> {
    return this.readLogTail(lines);
  }

  private async readReadyFile(): Promise<string | null> {
    try {
      const { stdout } = await this.host.exec('cat', [this.readyPath]);
      return stdout;
    } catch {
      return null; // not created yet
    }
  }
}

/**
 * Set the agent's sidecar `watch-enabled` flag (1/0). The running sidecar reads
 * this file each poll, so toggling auto_session enables/disables auto-start
 * without restarting the sidecar — leaving its session injection undisturbed.
 * Keyed by the agent's creds `slug` so it targets that agent's sidecar and not a
 * co-located one (CHOO-1440).
 */
export async function writeWatchEnabled(
  host: SidecarHost,
  slug: string,
  enabled: boolean
): Promise<void> {
  await host.exec('sh', [
    '-c',
    `mkdir -p ${quoteShellArg(sidecarAgentDir(slug))} && printf %s ${enabled ? '1' : '0'} > ${quoteShellArg(sidecarWatchEnabledRelPath(slug))}`,
  ]);
}

/**
 * Kill an agent's sidecar tmux session without a full launcher (no bundle/spec
 * needed) — used to fully tear down the sidecar (agent removal / host teardown).
 * Best-effort: a missing session is a no-op, not an error.
 */
export async function killSidecarSession(
  host: SidecarHost,
  sidecarTmuxName: string,
  log: SidecarLauncherLogger
): Promise<void> {
  try {
    await host.exec('tmux', ['kill-session', '-t', exactTmuxTarget(sidecarTmuxName)]);
  } catch (error) {
    log.debug('killSidecarSession: no existing sidecar session to kill', {
      sidecarTmuxName,
      error: String(error),
    });
  }
}

/** One entry of `tmux list-sessions`: the session's name and its working dir. */
export interface HostTmuxSession {
  name: string;
  /** `#{session_path}` — for an agent-scoped sidecar, the repo dir it was
   * launched with (`new-session -c`). */
  path: string;
}

function parseTmuxSessions(stdout: string): HostTmuxSession[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      return tab === -1
        ? { name: line, path: '' }
        : { name: line.slice(0, tab), path: line.slice(tab + 1) };
    });
}

/**
 * Agent-scoped sidecars running in `repoDir` that no live agent claims — the
 * stale generations to reap. See {@link reapStaleAgentSidecars}.
 *
 * Scoped to `repoDir` on purpose: a sidecar for some other directory belongs to
 * an agent this caller knows nothing about (another client's, another user's),
 * and killing it would be strictly destructive.
 */
export function staleAgentSidecarNames(
  sessions: readonly HostTmuxSession[],
  repoDir: string,
  expectedNames: readonly string[]
): string[] {
  const expected = new Set(expectedNames);
  return sessions
    .filter((s) => s.name.startsWith(AGENT_SIDECAR_TMUX_PREFIX))
    .filter((s) => s.path === repoDir)
    .filter((s) => !expected.has(s.name))
    .map((s) => s.name);
}

/**
 * Kill agent-scoped sidecars in `repoDir` whose name no agent at that directory
 * currently maps to.
 *
 * A sidecar's identity is a hash of `(repoDir, creds slug)` and every other code
 * path asks tmux exactly one question — does a session with *this* name exist —
 * so the moment either input changes, the running sidecar becomes unreachable
 * rather than replaced: the next launch starts a second one beside it and
 * nothing ever looks at the first again. Both inputs have changed in shipped
 * releases (the slug joined the hash in CHOO-1440; the storage migration
 * rewrote agent names), and a plain rename does it too. The orphans are not
 * merely untidy — each keeps polling its Switch rooms and renewing, so the agent
 * appears live from a process no client can see, stop, or upgrade.
 *
 * `expectedNames` must cover every agent at `repoDir` — siblings sharing a
 * directory each run their own sidecar by design (CHOO-1440).
 *
 * Best-effort by design: this is opportunistic cleanup alongside a launch, and
 * a host that cannot be enumerated is not a reason to fail the launch. Anything
 * actually reaped is logged as a warning rather than passing silently.
 */
export async function reapStaleAgentSidecars(
  host: SidecarHost,
  repoDir: string,
  expectedNames: readonly string[],
  log: SidecarLauncherLogger
): Promise<void> {
  if (expectedNames.length === 0) {
    // Reaping against an empty expected-set would kill the directory's live
    // sidecar. A caller with no agents to name has nothing to reconcile.
    log.warn('reapStaleAgentSidecars: refusing to reap with no expected sidecars', { repoDir });
    return;
  }

  let sessions: HostTmuxSession[];
  try {
    const { stdout } = await host.exec('tmux', [
      'list-sessions',
      '-F',
      '#{session_name}\t#{session_path}',
    ]);
    sessions = parseTmuxSessions(stdout);
  } catch {
    return; // no tmux server / no sessions
  }

  for (const name of staleAgentSidecarNames(sessions, repoDir, expectedNames)) {
    try {
      await host.exec('tmux', ['kill-session', '-t', exactTmuxTarget(name)]);
      log.warn('reapStaleAgentSidecars: killed a sidecar no agent claims', { name, repoDir });
    } catch (error) {
      log.warn('reapStaleAgentSidecars: failed to kill stale sidecar', {
        name,
        repoDir,
        error: String(error),
      });
    }
  }
}

/**
 * Reap LEGACY per-session sidecars — those named `<agentTmux>-sidecar`, one per
 * session — whose agent pane is gone: they are still polling Switch with nowhere
 * to inject.
 *
 * This deliberately does not match today's agent-scoped sidecars
 * (`switchdash-sidecar-<hash>`, see `agentSidecarTmuxName`). Those are *supposed*
 * to outlive every pane: with no live session the notification watcher is the
 * thing that starts one when the agent is next addressed, so reaping them for
 * having no panes would quietly disable auto-start. An agent-scoped sidecar is
 * torn down explicitly instead — via `killSidecarSession` when its agent is
 * renamed or deleted, and via `reapStaleAgentSidecars` when it is a leftover
 * generation of an agent that is still around.
 *
 * Best-effort: a missing tmux server (no sessions at all) is a no-op, not an error.
 */
export async function reapOrphanedSidecars(
  host: SidecarHost,
  log: SidecarLauncherLogger
): Promise<void> {
  let names: string[];
  try {
    const { stdout } = await host.exec('tmux', ['list-sessions', '-F', '#{session_name}']);
    names = stdout
      .split('\n')
      .map((n) => n.trim())
      .filter(Boolean);
  } catch {
    return; // no tmux server / no sessions
  }

  for (const name of names) {
    if (!name.endsWith(SIDECAR_TMUX_SUFFIX)) continue;
    const agentSession = name.slice(0, -SIDECAR_TMUX_SUFFIX.length);
    try {
      await host.exec('tmux', ['has-session', '-t', exactTmuxTarget(agentSession)]);
      continue; // agent still alive — sidecar is in use
    } catch {
      // agent gone — reap the orphan
    }
    try {
      await host.exec('tmux', ['kill-session', '-t', exactTmuxTarget(name)]);
      log.debug('reapOrphanedSidecars: reaped orphaned sidecar', { name });
    } catch (error) {
      log.warn('reapOrphanedSidecars: failed to kill orphaned sidecar', {
        name,
        error: String(error),
      });
    }
  }
}
