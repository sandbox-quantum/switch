import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import type { TrustedReleaseKey } from '../release-keys';
import { signedMessage } from '../release-signing';

/** A release signing key made for a test, and the trusted-list entry for it. */
export type TestSigningKey = { trusted: TrustedReleaseKey; privateKey: KeyObject };

export function testSigningKey(id: string): TestSigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    trusted: {
      id,
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    },
    privateKey,
  };
}

/** The `.sig` file a release workflow would publish for `version` and `sha256`. */
export function signRelease(key: TestSigningKey, version: string, sha256: string): string {
  return `${sign(null, Buffer.from(signedMessage(version, sha256)), key.privateKey).toString('base64')}\n`;
}
