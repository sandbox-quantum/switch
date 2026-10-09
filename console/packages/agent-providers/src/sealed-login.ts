import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';
import { z } from 'zod';

/**
 * Provider logins sealed to an agents controller's own key, so Switch stores
 * and relays only ciphertext. The controller makes an X25519 keypair and
 * gives Switch the public half; Console seals a login to it; only the
 * controller can open it. Switch Core checks the envelope's shape and the key
 * it names (`core/switch_core/management/sealed_logins.py`).
 *
 * - an ephemeral X25519 keypair, and its shared secret with the controller's key;
 * - `HKDF-SHA256(shared, salt = ephemeral public || controller public,
 *   info = "switch provider login v1")`, a 32-byte key;
 * - `AES-256-GCM` with a random 12-byte nonce, the tag appended to the
 *   ciphertext, and `aad = "switch-provider-login-v1\n<controller id>\n<provider>"`,
 *   so a login opens only for the controller and provider it was sealed for.
 */
export const SEALED_LOGIN_ALG = 'X25519-HKDF-SHA256-A256GCM';
const INFO = Buffer.from('switch provider login v1');
const TAG_BYTES = 16;

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);

export const sealedLoginSchema = z.strictObject({
  alg: z.literal(SEALED_LOGIN_ALG),
  key_id: z.string().min(1),
  ephemeral_key: base64,
  nonce: base64,
  ciphertext: base64,
});
export type SealedLogin = z.infer<typeof sealedLoginSchema>;

/** What is sealed: a login as Switch's provider connections hold one. */
export const providerLoginSchema = z.strictObject({
  kind: z.enum(['api-key', 'setup-token', 'auth-json']),
  credential: z.string().min(1).max(16384),
});
export type ProviderLogin = z.infer<typeof providerLoginSchema>;

/** A controller's keypair, each half the raw 32 bytes in base64. */
export type SealingKeyPair = { publicKey: string; privateKey: string };

export function generateSealingKeyPair(): SealingKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: rawPublic(publicKey).toString('base64'),
    privateKey: Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url').toString(
      'base64'
    ),
  };
}

/** The id a sealed login names its controller's key by: the first 16 hex digits of its SHA-256. */
export function sealingKeyId(publicKey: string): string {
  return createHash('sha256').update(rawKey(publicKey, 'public key')).digest('hex').slice(0, 16);
}

export function sealProviderLogin(input: {
  publicKey: string;
  controllerId: string;
  provider: string;
  login: ProviderLogin;
}): SealedLogin {
  const controller = importPublic(input.publicKey);
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublic = rawPublic(ephemeral.publicKey);
  const key = derive(
    diffieHellman({ privateKey: ephemeral.privateKey, publicKey: controller }),
    ephemeralPublic,
    rawKey(input.publicKey, 'public key')
  );
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(input.controllerId, input.provider));
  const plaintext = Buffer.from(JSON.stringify(providerLoginSchema.parse(input.login)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return {
    alg: SEALED_LOGIN_ALG,
    key_id: sealingKeyId(input.publicKey),
    ephemeral_key: ephemeralPublic.toString('base64'),
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/** Opens a login sealed to `keys`; a wrong key, controller, provider or a tampered envelope throws. */
export function openProviderLogin(input: {
  keys: SealingKeyPair;
  controllerId: string;
  provider: string;
  sealed: SealedLogin;
}): ProviderLogin {
  const sealed = sealedLoginSchema.parse(input.sealed);
  if (sealed.key_id !== sealingKeyId(input.keys.publicKey))
    throw new Error(
      'The login was sealed to another key than this controller’s; give the machine the login again.'
    );
  const ephemeralPublic = rawKey(sealed.ephemeral_key, 'ephemeral key');
  const key = derive(
    diffieHellman({
      privateKey: importPrivate(input.keys),
      publicKey: importPublic(sealed.ephemeral_key),
    }),
    ephemeralPublic,
    rawKey(input.keys.publicKey, 'public key')
  );
  const body = Buffer.from(sealed.ciphertext, 'base64');
  if (body.length <= TAG_BYTES) throw new Error('The sealed login holds no ciphertext.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64'), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(aad(input.controllerId, input.provider));
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([
      decipher.update(body.subarray(0, body.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new Error(
      'The sealed login does not open with this controller’s key for this provider; it was tampered with or sealed for another.'
    );
  }
  return providerLoginSchema.parse(JSON.parse(plaintext.toString('utf8')));
}

function aad(controllerId: string, provider: string): Buffer {
  return Buffer.from(`switch-provider-login-v1\n${controllerId}\n${provider}`);
}

function derive(shared: Buffer, ephemeralPublic: Buffer, controllerPublic: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([ephemeralPublic, controllerPublic]), INFO, 32)
  );
}

function rawKey(value: string, what: string): Buffer {
  const raw = Buffer.from(value, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== value)
    throw new Error(`The ${what} is not 32 bytes of base64.`);
  return raw;
}

function rawPublic(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: 'jwk' }).x!, 'base64url');
}

function importPublic(value: string): KeyObject {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: rawKey(value, 'public key').toString('base64url') },
    format: 'jwk',
  });
}

function importPrivate(keys: SealingKeyPair): KeyObject {
  return createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'X25519',
      d: rawKey(keys.privateKey, 'private key').toString('base64url'),
      x: rawKey(keys.publicKey, 'public key').toString('base64url'),
    },
    format: 'jwk',
  });
}
