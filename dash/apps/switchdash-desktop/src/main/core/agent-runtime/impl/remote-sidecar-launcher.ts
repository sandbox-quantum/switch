import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { exactTmuxTarget } from '@main/core/pty/tmux-session-name';
import { quoteShellArg } from '@main/utils/shellEscape';
import type { AgentLaunchSpec } from '../../../../sidecar/agent-launch-spec';

/**
 * Deploys and launches the switchdash remote runtime sidecar on the agent's VM
 * (CHOO-1059 → CHOO-1085), then waits for it to report a ready endpoint.
 *
 * The sidecar is agent-scoped: one per remote agent, serving every session on
 * the VM (the one switchdash starts over SSH and any it auto-starts) plus the
 * notification watcher. It must outlive the switchdash UI — that is the whole
 * point — so it runs inside its own detached tmux session rather than on the
 * launching SSH channel (which dies when switchdash disconnects). It prints
 * `{event:"ready",port,token}` to stdout, redirected to a ready file; the
 * launcher polls that file until the endpoint appears, then returns it so the
 * caller can point its remote sessions' hook env at the VM-local server.
 */

const SIDECAR_TMUX_SUFFIX = '-sidecar';
const SIDECAR_DIR = '.switchdash';
const BUNDLE_REL_PATH = `${SIDECAR_DIR}/sidecar.mjs`;
const BUNDLE_HASH_FILE = `${SIDECAR_DIR}/sidecar.mjs.sha256`;
const LAUNCH_SPEC_REL_PATH = `${SIDECAR_DIR}/agent-launch-spec.json`;
const WATCH_ENABLED_FILE = `${SIDECAR_DIR}/watch-enabled`;
const READY_FILE = `${SIDECAR_DIR}/sidecar.ready`;
const LOG_FILE = `${SIDECAR_DIR}/sidecar.log`;
const READY_POLL_INTERVAL_MS = 250;
const READY_MAX_ATTEMPTS = 80; // ~20s

export interface SidecarLaunchConfig {
  projectId: string;
  /** Absolute remote repo dir; the bundle, spec, ready file, and log live under .switchdash/. */
  repoDir: string;
  deeplinkScheme: string;
  /** Provider-specific launch recipe the sidecar's watcher materialises per auto-start. */
  launchSpec: AgentLaunchSpec;
}

export interface SidecarEndpoint {
  port: number;
  token: string;
}

/** The ready line the sidecar prints, plus the bundle hash the running process
 * was launched with (absent for a pre-CHOO-1085 sidecar). */
interface ReadyLine extends SidecarEndpoint {
  hash: string | null;
}

/** Narrow remote seam the launcher needs — satisfied by IExecutionContext + ssh-fs. */
export interface SidecarHost {
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
  putFile(localAbsPath: string, remoteRelPath: string): Promise<void>;
}

export interface SidecarLauncherLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

function sidecarEnv(config: SidecarLaunchConfig): Record<string, string> {
  return {
    SWITCHDASH_SIDECAR_PROJECT_ID: config.projectId,
    SWITCHDASH_SIDECAR_REPO_DIR: config.repoDir,
    SWITCHDASH_SIDECAR_DEEPLINK_SCHEME: config.deeplinkScheme,
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
    return { port: parsed.port, token: parsed.token, hash };
  }
  return null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deterministic, agent-scoped tmux session name for the sidecar, derived from
 * the remote repo dir so every caller (the SSH agent runtime and the
 * auto-session setup path) computes the same name and reattaches to the one
 * shared sidecar. Deliberately does NOT end in `-sidecar` so the legacy
 * per-session `reapOrphanedSidecars` never mistakes it for an orphan.
 */
export function agentSidecarTmuxName(repoDir: string): string {
  const hash = createHash('sha256').update(repoDir).digest('hex').slice(0, 16);
  return `switchdash-sidecar-${hash}`;
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

  /**
   * Reconcile-or-launch. The sidecar is designed to outlive the switchdash UI,
   * so on relaunch a still-running sidecar (its tmux session alive and its ready
   * file intact) is reattached to rather than redeployed — preserving its poll
   * queue and connection. Only when none is running (or it's stale) do we deploy
   * the bundle and start fresh.
   */
  async deployAndLaunch(): Promise<SidecarEndpoint> {
    // Always (re)write the launch spec first so a config change (e.g. new extra
    // args) takes effect on the next fresh launch, even when reattaching.
    await this.writeLaunchSpec();

    const localHash = await this.hashBundle();
    const existing = await this.reattachExisting(localHash);
    if (existing) {
      this.log.debug('RemoteSidecarLauncher: reattached to running sidecar', {
        sidecarTmuxName: this.sidecarTmuxName,
        port: existing.port,
      });
      return existing;
    }

    const remoteHash = await this.prepareDir();
    if (remoteHash === localHash) {
      this.log.debug('RemoteSidecarLauncher: bundle unchanged on host — skipping upload', {
        sidecarTmuxName: this.sidecarTmuxName,
      });
    } else {
      await this.host.putFile(this.bundlePath, BUNDLE_REL_PATH);
      await this.writeBundleHash(localHash);
    }
    await this.killSidecar();
    await this.startDetached(localHash);
    return this.awaitReady();
  }

  /**
   * Create the sidecar dir, clear any stale ready file, and return the hash of
   * the bundle already on the host (empty when absent) — one round-trip, so the
   * 1.2MB bundle SFTP is skipped whenever an identical copy is already deployed
   * (the common case: a new session reusing a prior session's bundle).
   */
  private async prepareDir(): Promise<string> {
    const script = [
      `mkdir -p ${quoteShellArg(SIDECAR_DIR)}`,
      `rm -f ${quoteShellArg(READY_FILE)}`,
      `[ -f ${quoteShellArg(BUNDLE_REL_PATH)} ] && cat ${quoteShellArg(BUNDLE_HASH_FILE)} 2>/dev/null || true`,
    ].join('; ');
    const { stdout } = await this.host.exec('sh', ['-c', script]);
    return stdout.trim();
  }

  private async writeLaunchSpec(): Promise<void> {
    const json = JSON.stringify(this.config.launchSpec);
    const b64 = Buffer.from(json, 'utf8').toString('base64');
    const spec = quoteShellArg(LAUNCH_SPEC_REL_PATH);
    // base64 round-trip avoids fighting shell quoting on the JSON payload. Write
    // to a per-process temp (`$$`) then atomically `mv` into place, so two agents
    // that share a repo dir (hence this spec file) can't interleave writes and
    // leave a torn, unparseable file that crashes the sidecar on startup.
    await this.host.exec('sh', [
      '-c',
      `mkdir -p ${quoteShellArg(SIDECAR_DIR)} && tmp=${spec}.$$.tmp && printf %s ${quoteShellArg(b64)} | base64 -d > "$tmp" && mv "$tmp" ${spec}`,
    ]);
  }

  private async writeBundleHash(hash: string): Promise<void> {
    await this.host.exec('sh', [
      '-c',
      `printf %s ${quoteShellArg(hash)} > ${quoteShellArg(BUNDLE_HASH_FILE)}`,
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
  private async reattachExisting(localHash: string): Promise<SidecarEndpoint | null> {
    try {
      await this.host.exec('tmux', ['has-session', '-t', exactTmuxTarget(this.sidecarTmuxName)]);
    } catch {
      return null; // not running
    }
    const raw = await this.readReadyFile();
    const ready = raw ? parseReady(raw) : null;
    if (!ready) return null;
    if (ready.hash !== localHash) {
      this.log.debug('RemoteSidecarLauncher: running sidecar is a stale bundle — relaunching', {
        sidecarTmuxName: this.sidecarTmuxName,
        runningHash: ready.hash,
        localHash,
      });
      return null;
    }
    return { port: ready.port, token: ready.token };
  }

  /**
   * Endpoint of an already-running current-bundle sidecar, or null if none is
   * running (or it is a stale bundle). Read-only — unlike `deployAndLaunch` it
   * never deploys, writes, or starts anything. For callers that only want to
   * talk to a sidecar if one already exists (e.g. cross-client discovery), so a
   * merely-configured agent does not cause a sidecar to be launched.
   */
  async probeExisting(): Promise<SidecarEndpoint | null> {
    return this.reattachExisting(await this.hashBundle());
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
    const inner =
      `${envPrefix} exec node ${quoteShellArg(BUNDLE_REL_PATH)} ` +
      `> ${quoteShellArg(READY_FILE)} 2>> ${quoteShellArg(LOG_FILE)}`;
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

  private async awaitReady(): Promise<SidecarEndpoint> {
    for (let attempt = 0; attempt < READY_MAX_ATTEMPTS; attempt++) {
      await this.assertAlive();
      const raw = await this.readReadyFile();
      const ready = raw ? parseReady(raw) : null;
      if (ready) return { port: ready.port, token: ready.token };
      await this.sleep(READY_POLL_INTERVAL_MS);
    }
    throw new Error(
      `sidecar did not report ready within ${
        (READY_MAX_ATTEMPTS * READY_POLL_INTERVAL_MS) / 1000
      }s — see ${this.config.repoDir}/${LOG_FILE}`
    );
  }

  private async assertAlive(): Promise<void> {
    try {
      await this.host.exec('tmux', ['has-session', '-t', exactTmuxTarget(this.sidecarTmuxName)]);
    } catch {
      const tail = await this.readLogTail();
      const logRef = `${this.config.repoDir}/${LOG_FILE}`;
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
  private async readLogTail(): Promise<string> {
    try {
      const { stdout } = await this.host.exec('tail', ['-n', '20', LOG_FILE]);
      return stdout.trim();
    } catch {
      return '';
    }
  }

  private async readReadyFile(): Promise<string | null> {
    try {
      const { stdout } = await this.host.exec('cat', [READY_FILE]);
      return stdout;
    } catch {
      return null; // not created yet
    }
  }
}

/**
 * Set the sidecar's live `watch-enabled` flag (1/0). The running sidecar reads
 * this file each poll, so toggling auto_session enables/disables auto-start
 * without restarting the sidecar — leaving its session injection undisturbed.
 */
export async function writeWatchEnabled(host: SidecarHost, enabled: boolean): Promise<void> {
  await host.exec('sh', [
    '-c',
    `mkdir -p ${quoteShellArg(SIDECAR_DIR)} && printf %s ${enabled ? '1' : '0'} > ${quoteShellArg(WATCH_ENABLED_FILE)}`,
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

/**
 * Kill sidecar tmux sessions on the host whose agent pane is gone. A sidecar is
 * named `<agentTmux>-sidecar`; if its `<agentTmux>` session no longer exists the
 * agent has exited (or its session was deleted) and the sidecar is an orphan —
 * still polling Switch with nowhere to inject. Best-effort: a missing tmux
 * server (no sessions at all) is a no-op, not an error.
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
