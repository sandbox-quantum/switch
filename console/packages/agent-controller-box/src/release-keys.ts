/**
 * The Ed25519 public keys a controller release must be signed with before
 * this controller installs it, by `run` (the release Switch names) or by
 * `update`. Built into the controller, so whoever runs the Switch server it
 * talks to cannot name a package of their own: they can only name one the
 * release workflows signed.
 *
 * Each key is `{ id, publicKey }`, `publicKey` being the key's SubjectPublicKeyInfo
 * (DER) in base64, as `scripts/generate-release-signing-key.mjs` prints it. A
 * release verifies when any key here verifies it, so rotating adds the new key,
 * ships a release with both, switches the signing secret, and only then removes
 * the old one. See "Release signing" in RELEASING.md.
 *
 * `install.sh` carries a copy of this list (between its TRUSTED RELEASE KEYS
 * markers); `release-keys.test.ts` fails when the two differ.
 *
 * With no key here, the controller installs no release at all, and says so.
 */
export type TrustedReleaseKey = { id: string; publicKey: string };

export const TRUSTED_RELEASE_KEYS: readonly TrustedReleaseKey[] = [
  {
    id: 'release-2026-10',
    publicKey: 'MCowBQYDK2VwAyEAaRFfp1Yd/b91KkZs8Vj/OQSdsZS2ifd+rZu24pKTMpU=',
  },
];
