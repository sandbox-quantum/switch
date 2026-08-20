import { isTransportFailure } from '@switch-console/core/exec';
import { isSshChannelOpenFailure } from '@main/core/ssh/lifecycle/ssh-channel-open-failure';
import type { CredentialsLogger } from '@main/core/switch-rooms/switch-credentials';
import { parseSwitchAgentCredentials } from '@main/core/switch-rooms/switch-credentials';

/**
 * Verifies an agent's remote host is ready to run a session before Switch Console
 * provisions one (CHOO-1059). Fails loud — a missing dependency, absent creds,
 * or an unreachable Switch endpoint each surface a clear, actionable error
 * rather than a half-started remote session that silently never connects.
 *
 * Checks:
 *  1. the remote working directory exists AND the base runtime is installed
 *     (`tmux`, `node`, `git`) at a usable version — one shell round-trip: the
 *     exec context prepends `cd <workDir> &&`, so a missing dir rejects the whole
 *     command, while present-but-missing tools and node's version are reported on
 *     stdout. A too-old node is rejected here rather than surfacing later as an
 *     opaque "sidecar exited during startup" — the sidecar bundle (and this
 *     module's own reachability probe) rely on `fetch`/optional chaining, which
 *     only stabilised in Node 18;
 *  2. the agent's Switch creds exist on the remote host — checked at the agent's
 *     provider-neutral per-agent path (`.switch/agents/<name>.json`) first, then
 *     the legacy `.claude/settings.local.json` for un-migrated installs
 *     (CHOO-1440) — read in parallel with (1);
 *  3. the host can actually reach the Switch API endpoint — the sidecar polls
 *     from the VM, so no egress means a dead agent.
 *
 * (1) and (2) run concurrently; on failure the working-dir/tools error is
 * preferred over the creds error, since a missing dir also makes the creds read
 * fail with a misleading message.
 */

const REQUIRED_BINARIES = ['tmux', 'node', 'git'] as const;
const REACHABILITY_TIMEOUT_MS = 5000;
// Global `fetch` and `AbortSignal.timeout` (used by the reachability probe below
// and throughout the sidecar bundle) are only stable from Node 18.
const MIN_NODE_MAJOR = 18;

// Prints `missing <tool>` for each absent binary and, when node is present,
// `node <version>` (e.g. `node v18.19.0`), then exits 0 — so a present working
// dir resolves with this report on stdout rather than rejecting. A rejected exec
// therefore means the prepended `cd <workDir>` failed (or the SSH channel could
// not open) — not a missing tool.
const HOST_READY_SCRIPT = `for b in ${REQUIRED_BINARIES.join(
  ' '
)}; do command -v "$b" >/dev/null 2>&1 || printf 'missing %s\\n' "$b"; done; command -v node >/dev/null 2>&1 && printf 'node %s\\n' "$(node -v 2>/dev/null)"`;

// Resolves on any HTTP response (even 4xx) and rejects only on a network/egress
// failure, so a reachable-but-unauthenticated endpoint still passes. No string
// literals → safe to pass as a single shell-quoted argument over SSH.
const REACHABILITY_SCRIPT = `fetch(process.argv[1], { signal: AbortSignal.timeout(${REACHABILITY_TIMEOUT_MS}) }).then(() => process.exit(0)).catch((e) => { console.error(String(e)); process.exit(1); })`;

export interface RemotePreflightExec {
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export interface RemotePreflightFs {
  read(path: string): Promise<{ content: string }>;
}

/**
 * Addresses that mean "the machine this resolves on". A remote host handed one
 * of these is being pointed at itself, never at the machine running Switch
 * Console — so no amount of egress will make the endpoint reachable.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '[::]']);

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(endpoint).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * A captured failure, fit to sit in a parenthetical.
 *
 * Command output arrives with its trailing newline attached; interpolated
 * straight into a sentence that produced the stray space before the full stop
 * in `… TypeError: fetch failed . The sidecar polls …`.
 */
function probeDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, ' ').trim();
}

export interface RemotePreflightDeps {
  ctx: RemotePreflightExec;
  fs: RemotePreflightFs;
  log: CredentialsLogger;
  host: string;
  workDir: string;
  /**
   * Whether the host's SSH connection is down because authentication was
   * rejected. That state does not auto-recover, so it changes the advice given
   * for a transport failure from "wait" to "fix the credentials".
   */
  isAuthSuspended: () => boolean;
  /** Candidate creds files (relative to the working dir) to check, in priority
   * order — the agent's neutral `.switch/agents/<name>.json` first, then the
   * legacy `.claude/settings.local.json`. The first that parses is used. */
  credsRelPaths: string[];
}

export async function preflightRemoteSession(deps: RemotePreflightDeps): Promise<void> {
  const [hostReady, endpoint] = await Promise.allSettled([
    assertHostReady(deps.ctx, deps.workDir, deps.host, deps.log, deps.isAuthSuspended),
    readRemoteEndpoint(deps),
  ]);
  if (hostReady.status === 'rejected') throw hostReady.reason;
  if (endpoint.status === 'rejected') throw endpoint.reason;
  await assertEndpointReachable(deps.ctx, endpoint.value, deps.host);
}

// One round-trip for the working dir + required tools. The exec context prepends
// `cd <workDir> &&`, so a missing dir (or an exhausted SSH channel) rejects the
// command; a present dir resolves with any missing tools listed on stdout.
async function assertHostReady(
  ctx: RemotePreflightExec,
  workDir: string,
  host: string,
  log: CredentialsLogger,
  isAuthSuspended: () => boolean
): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await ctx.exec('sh', ['-c', HOST_READY_SCRIPT]));
  } catch (error) {
    const detail = probeDetail(error);
    const cause = error instanceof Error ? error.cause : undefined;
    // A channel-open REFUSAL (the server answered "no") usually means session
    // exhaustion; do not blame sshd MaxSessions for every transport failure —
    // a wedged shared connection produces the same symptom and Switch Console now
    // rebuilds it automatically.
    if (isSshChannelOpenFailure(error) || isSshChannelOpenFailure(cause)) {
      log.warn('preflightRemoteSession: SSH channel open refused on host-ready probe', {
        workDir,
        host,
        detail,
      });
      throw new Error(
        `the SSH connection to host '${host}' could not open another channel (${detail}). Every remote session on a host shares one SSH connection — either the server's sshd MaxSessions is exhausted (close some sessions on '${host}' or raise it), or the shared connection is unhealthy; Switch Console rebuilds an unhealthy connection automatically, so retry in a few seconds.`
      );
    }
    if (isTransportFailure(error)) {
      const authSuspended = isAuthSuspended();
      log.warn('preflightRemoteSession: SSH transport failed on host-ready probe', {
        workDir,
        host,
        detail,
        authSuspended,
      });
      // Only the reconnecting states get told to wait. A rejected credential
      // never becomes accepted on its own, and the reconnect loop is stopped
      // for exactly that reason, so promising a recovery here would leave the
      // user waiting for something that is not coming.
      throw new Error(
        authSuspended
          ? `SSH authentication to host '${host}' was rejected, so the connection is stopped. It will not retry on its own. Fix the credentials for '${host}' — the key or agent your SSH config uses for it — then start the session again. (${detail})`
          : `The SSH connection to host '${host}' dropped. Switch Console is reconnecting in the background; start the session again in a few seconds. (${detail})`
      );
    }
    log.warn('preflightRemoteSession: host-ready probe failed', { workDir, host, detail });
    throw new Error(
      `remote working directory '${workDir}' on host '${host}' is not usable (${detail}). If it is missing, clone the repo there or point the agent at an existing directory.`
    );
  }

  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const missing = lines
    .filter((line) => line.startsWith('missing '))
    .map((line) => line.slice('missing '.length));
  if (missing.length > 0) {
    throw new Error(
      `remote host '${host}' is missing required tools: ${missing.join(', ')}. Install them on the host before running a remote session.`
    );
  }

  const versionLine = lines.find((line) => line.startsWith('node '));
  const nodeVersion = versionLine?.slice('node '.length) ?? '';
  const major = Number.parseInt(nodeVersion.replace(/^v/, ''), 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    throw new Error(
      `remote host '${host}' has Node ${nodeVersion || '(unknown)'}, but the Switch Console sidecar needs Node ${MIN_NODE_MAJOR} or newer. Install a current Node on the host (e.g. via NodeSource or nvm) so it is the default \`node\` on PATH, then retry.`
    );
  }
}

async function readRemoteEndpoint(deps: RemotePreflightDeps): Promise<string> {
  const primary = deps.credsRelPaths[0] ?? '.switch/agents';
  // Track the FIRST file that was present but unparseable/incomplete, so the
  // error names the actual offending file rather than always the primary path —
  // a stale fallback (an old id-keyed `.switch/agents/<id>.json` or the legacy
  // `.claude/settings.local.json`) is a common cause and must be pinpointed.
  let incompletePath: string | null = null;
  for (const relPath of deps.credsRelPaths) {
    let content: string;
    try {
      ({ content } = await deps.fs.read(relPath));
    } catch {
      continue;
    }
    const creds = parseSwitchAgentCredentials(content, deps.log);
    if (creds) return creds.apiEndpoint;
    if (incompletePath === null) incompletePath = relPath;
  }
  if (incompletePath !== null) {
    throw new Error(
      `Switch credentials at ${incompletePath} on remote host '${deps.host}' are incomplete — re-run remote setup for this agent.`
    );
  }
  throw new Error(
    `no Switch credentials at ${primary} on remote host '${deps.host}' — run remote setup for this agent first.`
  );
}

async function assertEndpointReachable(
  ctx: RemotePreflightExec,
  apiEndpoint: string,
  host: string
): Promise<void> {
  try {
    await ctx.exec('node', ['-e', REACHABILITY_SCRIPT, apiEndpoint]);
  } catch (error) {
    const detail = probeDetail(error);
    // A loopback endpoint is not an egress problem and never becomes one: the
    // address resolves on the host to the host, so the probe is asking the VM
    // to call itself. The old message quoted the endpoint and still sent the
    // user to their firewall, where there was nothing to find.
    if (isLoopbackEndpoint(apiEndpoint)) {
      throw new Error(
        `Host '${host}' is configured to reach Switch at ${apiEndpoint}, which on that host means the host itself — not the machine running Switch Console. No firewall change will make this work. Set this agent's Switch endpoint to an address '${host}' can resolve, such as the Switch server's LAN or public address, then re-run remote setup for it. (probe: ${detail})`
      );
    }
    throw new Error(
      `Host '${host}' could not reach Switch at ${apiEndpoint}. The sidecar polls Switch from the host, so '${host}' itself needs network access to that address — reaching it from this machine is not enough. Check the host's outbound access and that the endpoint is correct for it. (probe: ${detail})`
    );
  }
}
