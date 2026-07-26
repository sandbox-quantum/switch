/**
 * On-VM layout of the switchdash sidecar's files, relative to an agent's remote
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

/** Shared sidecar bundle + its hash (identical for every agent in the dir). */
export const SIDECAR_BUNDLE_REL_PATH = `${SIDECAR_DIR}/sidecar.mjs`;
export const SIDECAR_BUNDLE_HASH_REL_PATH = `${SIDECAR_DIR}/sidecar.mjs.sha256`;

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

export function sidecarLogRelPath(slug: string): string {
  return `${sidecarAgentDir(slug)}/sidecar.log`;
}

/** Legacy pre-CHOO-1440 shared (per-dir) state paths, kept as a fallback for a
 * sidecar started without an agent slug. */
export const LEGACY_LAUNCH_SPEC_REL_PATH = `${SIDECAR_DIR}/agent-launch-spec.json`;
export const LEGACY_WATCH_ENABLED_REL_PATH = `${SIDECAR_DIR}/watch-enabled`;
