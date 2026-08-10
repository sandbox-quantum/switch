/**
 * On-VM layout of the Switch Console sidecar's files, relative to an agent's remote
 * repo dir. Shared by the launcher (main process) and the sidecar bundle so both
 * agree on where each file lives.
 *
 * The bundle is shared per directory (identical bytes — deduped on upload), but
 * every piece of per-agent STATE is keyed by the agent's creds slug so multiple
 * agents in one directory each get their own sidecar without clobbering each
 * other's launch spec, watch flag, ready file, or log (CHOO-1440). POSIX
 * separators — the host is always POSIX.
 */

export const SIDECAR_DIR = '.switchdash';

/**
 * Shared sidecar bundle (identical for every agent in the dir).
 *
 * There is deliberately no companion hash file: keeping one alongside the
 * bundle meant two writes that could tear or fall out of step, and a stale hash
 * silently defeats the comparison it exists to serve. The bundle is hashed from
 * its own bytes instead — on the host when deciding whether to upload, and by
 * the sidecar itself when reporting what it is running.
 */
export const SIDECAR_BUNDLE_REL_PATH = `${SIDECAR_DIR}/sidecar.mjs`;

/** Per-agent state directory, keyed by the creds slug (definition name / id). */
export function sidecarAgentDir(slug: string): string {
  return `${SIDECAR_DIR}/agents/${slug}`;
}

export function sidecarLaunchSpecRelPath(slug: string): string {
  return `${sidecarAgentDir(slug)}/agent-launch-spec.json`;
}

export function sidecarWatchEnabledRelPath(slug: string): string {
  return `${sidecarAgentDir(slug)}/watch-enabled`;
}

export function sidecarReadyRelPath(slug: string): string {
  return `${sidecarAgentDir(slug)}/sidecar.ready`;
}

/**
 * Current hook endpoint (port on line 1, token on line 2), rewritten by the
 * sidecar every time it binds. Sessions are launched with the *path* to this
 * file rather than the port/token themselves, so a restarted sidecar — which
 * always gets a fresh ephemeral port and token — is still reachable from panes
 * that were spawned against the previous process.
 */
export function sidecarEndpointRelPath(slug: string): string {
  return `${sidecarAgentDir(slug)}/endpoint`;
}

/** Durable sidecar state (session registry + event epoch), survives restarts. */
export function sidecarStateRelPath(slug: string): string {
  return `${sidecarAgentDir(slug)}/state.json`;
}

/** Atomically-created deploy lock directory (mkdir is atomic on POSIX). */
export function sidecarDeployLockRelPath(slug: string): string {
  return `${sidecarAgentDir(slug)}/deploy.lock`;
}

export function sidecarLogRelPath(slug: string): string {
  return `${sidecarAgentDir(slug)}/sidecar.log`;
}

/** Legacy pre-CHOO-1440 shared (per-dir) state paths, kept as a fallback for a
 * sidecar started without an agent slug. */
export const LEGACY_LAUNCH_SPEC_REL_PATH = `${SIDECAR_DIR}/agent-launch-spec.json`;
export const LEGACY_WATCH_ENABLED_REL_PATH = `${SIDECAR_DIR}/watch-enabled`;
