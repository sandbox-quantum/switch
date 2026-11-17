/**
 * Seals a provider login to a machine's own key in the browser, as Console
 * does in its main process (`@switch-console/agent-providers`'
 * `sealProviderLogin`), so Switch stores and relays only ciphertext and only
 * that machine's controller can open it:
 *
 * - an ephemeral X25519 keypair, and its shared secret with the machine's key;
 * - `HKDF-SHA256(shared, salt = ephemeral public || machine public,
 *   info = "switch provider login v1")`, a 32-byte key;
 * - `AES-256-GCM` with a random 12-byte nonce, the tag after the ciphertext,
 *   and `aad = "switch-provider-login-v1\n<controller id>\n<provider>"`, so a
 *   login opens only for the controller and provider it was sealed for.
 *
 * Uses Web Crypto only, which every current browser has, X25519 included.
 */

export const SEALED_LOGIN_ALG = 'X25519-HKDF-SHA256-A256GCM';

export type SealedLogin = {
  alg: typeof SEALED_LOGIN_ALG;
  key_id: string;
  ephemeral_key: string;
  nonce: string;
  ciphertext: string;
};

/** What a login is, as the machine's provider takes it; a `vertex` credential is `vertexLoginCredential`'s JSON. */
export type ProviderLogin = { kind: 'api-key' | 'setup-token' | 'vertex'; credential: string };

const INFO = new TextEncoder().encode('switch provider login v1');

function bytesOf(base64: string, what: string): Uint8Array<ArrayBuffer> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  } catch {
    throw new Error(`The ${what} is not base64.`);
  }
  if (raw.length !== 32) throw new Error(`The ${what} is not 32 bytes.`);
  return raw;
}

function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The id a sealed login names its machine's key by: the first 16 hex digits of its SHA-256. */
export async function sealingKeyId(publicKey: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytesOf(publicKey, 'machine key'))
  );
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

export async function sealProviderLogin(input: {
  /** The machine's X25519 public key, its raw 32 bytes in base64. */
  publicKey: string;
  controllerId: string;
  provider: string;
  login: ProviderLogin;
}): Promise<SealedLogin> {
  const credential = input.login.credential.trim();
  if (!credential) throw new Error('There is no key or token to give the machine.');
  const subtle = crypto.subtle;
  const machinePublic = bytesOf(input.publicKey, 'machine key');
  const machine = await subtle.importKey('raw', machinePublic, { name: 'X25519' }, false, []);
  const ephemeral = (await subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const ephemeralPublic = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey));
  const shared = await subtle.deriveBits(
    { name: 'X25519', public: machine },
    ephemeral.privateKey,
    256
  );
  const salt = new Uint8Array(64);
  salt.set(ephemeralPublic, 0);
  salt.set(machinePublic, 32);
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: INFO },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ kind: input.login.kind, credential })
  );
  const ciphertext = new Uint8Array(
    await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: new TextEncoder().encode(
          `switch-provider-login-v1\n${input.controllerId}\n${input.provider}`
        ),
        tagLength: 128,
      },
      key,
      plaintext
    )
  );
  return {
    alg: SEALED_LOGIN_ALG,
    key_id: await sealingKeyId(input.publicKey),
    ephemeral_key: base64Of(ephemeralPublic),
    nonce: base64Of(nonce),
    ciphertext: base64Of(ciphertext),
  };
}
