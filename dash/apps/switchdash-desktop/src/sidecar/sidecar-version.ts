import { artifactVersion, contractRange } from '@switchdash/shared';

/**
 * The sidecar's release version, `MAJOR.MINOR.PATCH`.
 *
 * It says **where** this sidecar is — which release you are running — and
 * nothing about what it can talk to. Compatibility lives in the
 * `sidecar-control` contract (see `artifacts.yaml`), which the sidecar declares
 * in its ready file (CHOO-1865). The two move independently: a release that
 * changes nothing on the wire bumps this and leaves the contract alone.
 *
 * Whether a running sidecar is the exact build this client ships — and so
 * whether an upgrade exists — is decided by the content hash carried alongside,
 * never by this number. That is deliberate: a forgotten bump then cannot make a
 * changed build look up-to-date, and dev builds (which nobody bumps between
 * iterations) still redeploy correctly. The full identity a user sees is
 * `MAJOR.MINOR.PATCH+<shorthash>` — semver build metadata.
 *
 * Derived from `artifacts.yaml`, which is the only place it is written. Nothing
 * else declares the sidecar's version: it is deployed by switchdash rather than
 * published, so it has no packaging file of its own.
 *
 * **The major must stay at 1 through this transition.** switchdash installs
 * already in the field judge compatibility on the major and parse only `x.y`,
 * so `1.7` → `1.7.0` reads as the same version to them and nothing is replaced.
 * Going to `2.0.0` would make every existing install see this sidecar as
 * incompatible and replace it, while a newer install replaces it back —
 * CHOO-1937, forever.
 *
 * A *new* endpoint is not a wire break. Raising the contract past what a running
 * sidecar reports only helps if the floor moves with it, and that kills every
 * older sidecar on sight. So the client owns this instead: call the endpoint,
 * and when an older sidecar 404s it, fail the operation with a message naming
 * the upgrade rather than continuing without whatever the endpoint was for.
 */
export const SIDECAR_VERSION = artifactVersion('sidecar');

/** The artifact name the sidecar declares itself as. */
export const SIDECAR_ARTIFACT = 'sidecar';

/** The artifact name switchdash declares itself as, on the same contract. */
export const SIDECAR_CLIENT_ARTIFACT = 'switchdash';

/** What a sidecar of this build speaks. Written into its ready file. */
export const SIDECAR_CONTROL = contractRange('sidecar-control', SIDECAR_ARTIFACT);

/** What this switchdash speaks to a sidecar. */
export const SIDECAR_CLIENT_CONTROL = contractRange('sidecar-control', SIDECAR_CLIENT_ARTIFACT);

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

/**
 * A version as numbers; a missing or unparseable part reads as 0.
 *
 * Two-part versions still parse, and must keep doing so: sidecars deployed
 * before three-part semver report `x.y` and are still running on hosts. Their
 * patch reads as 0, which makes `1.7` and `1.7.0` compare equal — exactly what
 * stops the two from replacing each other.
 */
function parseSidecarVersion(version: string | null): {
  major: number;
  minor: number;
  patch: number;
} {
  if (!version) return { major: 0, minor: 0, patch: 0 };
  const [rawMajor, rawMinor, rawPatch] = version.split('.');
  const part = (raw: string | undefined): number => {
    const value = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(value) ? value : 0;
  };
  return { major: part(rawMajor), minor: part(rawMinor), patch: part(rawPatch) };
}

/**
 * Order two versions: negative when `a` is older, 0 when equal, positive when
 * `a` is newer.
 *
 * This is the ONE machine decision the release number takes part in, and it is a
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
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/** This client's own major, for compatibility comparisons. */
export const SIDECAR_CLIENT_MAJOR = sidecarMajor(SIDECAR_VERSION);
