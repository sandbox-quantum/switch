import { createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';

/**
 * SSH public host keys for tests, made when the tests run rather than written
 * into them, so the repository holds no key material. Each key is in the
 * OpenSSH wire format a known_hosts line carries (base64), with the
 * fingerprint `ssh-keygen -lf` prints for it, worked out here from the format
 * rather than by the code under test.
 */
export type TestHostKey = { key: string; fingerprint: string };

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function hostKey(blob: Buffer): TestHostKey {
  const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return { key: blob.toString('base64'), fingerprint: `SHA256:${digest}` };
}

export function ed25519HostKey(): TestHostKey {
  const { publicKey } = generateKeyPairSync('ed25519');
  const { x } = publicKey.export({ format: 'jwk' });
  return hostKey(
    Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.from(x!, 'base64url'))])
  );
}

export function ecdsaHostKey(): TestHostKey {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { x, y } = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(x!, 'base64url'),
    Buffer.from(y!, 'base64url'),
  ]);
  return hostKey(
    Buffer.concat([sshString('ecdsa-sha2-nistp256'), sshString('nistp256'), sshString(point)])
  );
}

/** A host name hashed as `ssh-keygen -H` writes it: `|1|<salt>|<HMAC-SHA1 of the name>`. */
export function hashedHostName(name: string): string {
  const salt = randomBytes(20);
  const hash = createHmac('sha1', salt).update(name).digest();
  return `|1|${salt.toString('base64')}|${hash.toString('base64')}`;
}
