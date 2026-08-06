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
 *
 * A *new* endpoint is not a wire break. Raising `x` past what a running sidecar
 * reports only helps if `MIN_SUPPORTED_SIDECAR_MAJOR` moves with it, and that
 * kills every older sidecar on sight — including one an older switchdash on the
 * same host will then kill right back, each replacing the other forever. So the
 * client owns this instead: call the endpoint, and when an older sidecar 404s
 * it, fail the operation with a message naming the upgrade rather than
 * continuing without whatever the endpoint was for.
 */
export const SIDECAR_VERSION = '1.8';

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

/** An `x.y` version as numbers; a missing or unparseable part reads as 0. */
function parseSidecarVersion(version: string | null): { major: number; minor: number } {
  if (!version) return { major: 0, minor: 0 };
  const [rawMajor, rawMinor] = version.split('.');
  const major = Number.parseInt(rawMajor ?? '', 10);
  const minor = Number.parseInt(rawMinor ?? '', 10);
  return {
    major: Number.isFinite(major) ? major : 0,
    minor: Number.isFinite(minor) ? minor : 0,
  };
}

/**
 * Order two `x.y` versions: negative when `a` is older, 0 when equal, positive
 * when `a` is newer.
 *
 * This is the ONE machine decision the minor takes part in, and it is a
 * tie-breaker rather than a build check. "Is this the same build" stays on the
 * content hash, for the reasons above; this only answers "is the sidecar already
 * on the host newer than what I ship", so a client never replaces a sidecar
 * deployed by a newer switchdash. Without that ordering, two installs on
 * different releases sharing a host each see the other's build as an upgrade and
 * replace it in turn, forever (CHOO-1937).
 */
export function compareSidecarVersions(a: string | null, b: string | null): number {
  const left = parseSidecarVersion(a);
  const right = parseSidecarVersion(b);
  return left.major - right.major || left.minor - right.minor;
}

/** This client's own major, for compatibility comparisons. */
export const SIDECAR_CLIENT_MAJOR = sidecarMajor(SIDECAR_VERSION);
