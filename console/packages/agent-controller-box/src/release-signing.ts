import { createPublicKey, type KeyObject, verify } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Fetch } from './api';
import type { TrustedReleaseKey } from './release-keys';

/**
 * Release signatures. The release workflows sign, with Ed25519, the message
 *
 *     switch-agent-controller-release-v1\n<version>\n<sha256>\n
 *
 * (`<sha256>` the package's digest in lowercase hex), and publish the
 * signature, base64 on one line, beside the package as `<package>.sig`. The
 * message binds the version as well as the bytes, so a signed package cannot be
 * offered as another version than the one it was released as.
 */
export const SIGNED_MESSAGE_PREFIX = 'switch-agent-controller-release-v1';

/** The largest signature file read: a signature is 88 base64 characters. */
const MAX_SIGNATURE_BYTES = 1024;
const SIGNATURE_TIMEOUT_MS = 60 * 1000;

export const NO_TRUSTED_KEYS =
  'This controller build trusts no release signing key (src/release-keys.ts is empty), so it installs no release: it could not tell a release the workflows signed from any other package. Install a release that carries a signing key by hand.';

/** What a release signature signs, for `version` and the package's SHA-256. */
export function signedMessage(version: string, sha256: string): string {
  return `${SIGNED_MESSAGE_PREFIX}\n${version}\n${sha256.toLowerCase()}\n`;
}

/** Where the signature of the package at `packageUrl` is: `<path>.sig`, the query kept. */
export function signatureUrl(packageUrl: string): string {
  const url = new URL(packageUrl);
  url.pathname = `${url.pathname}.sig`;
  return url.toString();
}

/** Throws when `keys` is empty: nothing could be verified. */
export function assertTrustedKeys(keys: readonly TrustedReleaseKey[]): void {
  if (keys.length === 0) throw new Error(NO_TRUSTED_KEYS);
}

/** A trusted key as a key object; throws when it is not an Ed25519 public key. */
export function publicKeyOf(key: TrustedReleaseKey): KeyObject {
  const object = createPublicKey({
    key: Buffer.from(key.publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
  if (object.asymmetricKeyType !== 'ed25519')
    throw new Error(`Trusted release key ${key.id} is not an Ed25519 key.`);
  return object;
}

/**
 * Checks `signature` (the `.sig` file's text) over `version` and `sha256`
 * against `keys`; the id of the key that verifies it. Throws when none does.
 */
export function verifyReleaseSignature(input: {
  version: string;
  sha256: string;
  signature: string;
  keys: readonly TrustedReleaseKey[];
}): string {
  assertTrustedKeys(input.keys);
  const text = input.signature.trim();
  const bytes = /^[A-Za-z0-9+/]+={0,2}$/.test(text) ? Buffer.from(text, 'base64') : null;
  if (!bytes || bytes.length !== 64)
    throw new Error('The release signature is not a base64 Ed25519 signature.');
  const message = Buffer.from(signedMessage(input.version, input.sha256), 'utf8');
  for (const key of input.keys) if (verify(null, message, publicKeyOf(key), bytes)) return key.id;
  throw new Error(
    `The release signature does not verify switch-agent-controller ${input.version} with SHA-256 ${input.sha256} against any trusted release key (${input.keys.map((key) => key.id).join(', ')}).`
  );
}

/** Fetches the signature published beside the package at `packageUrl`. */
export async function fetchSignature(
  fetch: Fetch,
  packageUrl: string,
  signal: AbortSignal | null
): Promise<string> {
  const url = signatureUrl(packageUrl);
  const signals = [AbortSignal.timeout(SIGNATURE_TIMEOUT_MS), ...(signal ? [signal] : [])];
  const response = await fetch(url, { signal: AbortSignal.any(signals) });
  if (!response.ok)
    throw new Error(
      `The release has no signature: fetching ${url} answered ${response.status}. A controller installs only signed releases.`
    );
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_SIGNATURE_BYTES)
    throw new Error(`${url} is ${body.byteLength} bytes, too large for a release signature.`);
  return new TextDecoder().decode(body);
}

/**
 * Fetches the signature of the package downloaded to `file` from `url` and
 * verifies it for `version` and the package's `sha256`; a package whose
 * signature is missing or does not verify is deleted.
 */
export async function verifyDownloadedRelease(input: {
  fetch: Fetch;
  file: string;
  url: string;
  version: string;
  sha256: string;
  keys: readonly TrustedReleaseKey[];
  signal: AbortSignal | null;
}): Promise<string> {
  try {
    const signature = await fetchSignature(input.fetch, input.url, input.signal);
    return verifyReleaseSignature({ ...input, signature });
  } catch (error) {
    await rm(input.file, { force: true });
    const said = error instanceof Error ? error.message : String(error);
    throw new Error(`${said} The package from ${input.url} was deleted.`, { cause: error });
  }
}
