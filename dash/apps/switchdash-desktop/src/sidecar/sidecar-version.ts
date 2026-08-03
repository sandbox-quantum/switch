/**
 * The sidecar's human-readable version, `x.y`.
 *
 * - `x` (major) — the wire contract between client and sidecar. Bump it on a
 *   BREAKING change (the ready line, an endpoint's request/response, or the
 *   on-disk layout the two sides share). Compatibility — "can this client talk
 *   to that running sidecar" — is judged on the major alone.
 * - `y` (minor) — a release/patch counter, purely for humans to read. It drives
 *   NO machine decision. Whether a running sidecar is the exact build this
 *   client ships — and therefore whether an upgrade is available — is decided by
 *   the content hash carried alongside, not by `y`.
 *
 * Keeping "is it the same build" on the hash rather than on `y` is deliberate: a
 * forgotten `y` bump then can never make a changed build look up-to-date, and
 * dev builds (which nobody bumps between iterations) still redeploy correctly.
 * The full identity a user sees is `x.y+<shorthash>` — semver build metadata —
 * so they read `1.0` while the machine compares the hash.
 *
 * Bump policy: `x` on a wire break (and only then), `y` on every release that
 * changes the sidecar.
 */
export const SIDECAR_VERSION = '1.4';

/**
 * Oldest major this client can still speak to. Raise it only when support for an
 * older sidecar is genuinely dropped — every sidecar below it is replaced on
 * sight, including one with live sessions. A sidecar predating versioning
 * reports no version and is treated as major 0.
 */
export const MIN_SUPPORTED_SIDECAR_MAJOR = 0;

/** The major of an `x.y` version string; 0 for a missing/unparseable one. */
export function sidecarMajor(version: string | null): number {
  if (!version) return 0;
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : 0;
}

/** This client's own major, for compatibility comparisons. */
export const SIDECAR_CLIENT_MAJOR = sidecarMajor(SIDECAR_VERSION);
