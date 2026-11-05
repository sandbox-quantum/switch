/**
 * A provider login sealed in the browser to the person's own box, so Switch
 * stores and relays only ciphertext (hosted agents v2, Switch web). The same
 * wire format as Console's `sealProviderLogin`
 * (`console/packages/agent-providers/src/sealed-login.ts`), made with the
 * browser's own WebCrypto and no library:
 *
 * - an ephemeral X25519 keypair, its private half non-extractable, used once;
 * - `HKDF-SHA256(shared, salt = ephemeral public || controller public,
 *   info = "switch provider login v1")`, a non-extractable AES-256-GCM key;
 * - `AES-256-GCM` with a random 12-byte nonce, the tag appended to the
 *   ciphertext, and `aad = "switch-provider-login-v1\n<controller id>\n<provider>"`.
 *
 * It seals only to a key it has checked (`keyId` is the key's own id), and
 * never falls back to sending anything in plain text. Nothing here logs,
 * stores or throws text holding the login.
 */

export const SEALED_LOGIN_ALG = "X25519-HKDF-SHA256-A256GCM";
const INFO = "switch provider login v1";
const MAX_CREDENTIAL = 16384;

export type LoginKind = "api-key" | "setup-token" | "auth-json" | "vertex";
export const LOGIN_KINDS: readonly LoginKind[] = ["api-key", "setup-token", "auth-json", "vertex"];

export type ProviderLogin = { kind: LoginKind; credential: string };

export type SealedLogin = {
  alg: typeof SEALED_LOGIN_ALG;
  key_id: string;
  ephemeral_key: string;
  nonce: string;
  ciphertext: string;
};

/** Why a login wasn't sealed: fixed words, never any part of the login. */
export class SealRefused extends Error {
  constructor(
    readonly code: "bad_key" | "key_mismatch" | "bad_target" | "bad_login" | "unsupported",
  ) {
    super(
      {
        bad_key: "Switch sent a key for your cloud that isn't a key, so your login wasn't sent.",
        bad_target: "Switch couldn't tell which cloud the login is for, so it wasn't sent.",
        key_mismatch: "Switch couldn't check your cloud's key, so your login wasn't sent.",
        bad_login: "That login isn't one Switch can give your cloud.",
        unsupported: "This browser can't seal a login. Use Switch Console to add it.",
      }[code],
    );
    this.name = "SealRefused";
  }
}

/**
 * What a login may be sealed for. Both go into the AAD between newlines, so
 * neither may hold one (or anything else outside these characters).
 */
const CONTROLLER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new SealRefused("unsupported");
  return subtle;
}

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(value: string): Uint8Array {
  const text = atob(value);
  const out = new Uint8Array(text.length);
  for (let at = 0; at < text.length; at++) out[at] = text.charCodeAt(at);
  return out;
}

/** The raw 32 bytes of a key given as canonical base64, or null. */
export function rawKey(value: string): Uint8Array | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  let raw: Uint8Array;
  try {
    raw = fromBase64(value);
  } catch {
    return null;
  }
  return raw.length === 32 && toBase64(raw) === value ? raw : null;
}

/** The id a sealed login names its controller's key by: the first 16 hex digits of its SHA-256. */
export async function sealingKeyId(raw: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await subtleCrypto().digest("SHA-256", raw as BufferSource));
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** Whether this browser can seal a login (X25519 in WebCrypto). */
export async function canSeal(): Promise<boolean> {
  try {
    await subtleCrypto().generateKey({ name: "X25519" }, false, ["deriveBits"]);
    return true;
  } catch {
    return false;
  }
}

function checkLogin(login: ProviderLogin): void {
  if (
    !login ||
    !LOGIN_KINDS.includes(login.kind) ||
    typeof login.credential !== "string" ||
    login.credential.length < 1 ||
    login.credential.length > MAX_CREDENTIAL
  )
    throw new SealRefused("bad_login");
}

/**
 * Seals `login` to the controller key `publicKey`, whose id must be `keyId`,
 * for `controllerId` and `provider`. Throws `SealRefused` and sends nothing
 * when the key or the login isn't right, or the browser can't seal.
 */
export async function sealLogin(
  input: {
    publicKey: string;
    keyId: string;
    controllerId: string;
    provider: string;
    login: ProviderLogin;
  },
): Promise<SealedLogin> {
  const subtle = subtleCrypto();
  const controllerRaw = rawKey(input.publicKey);
  if (controllerRaw === null) throw new SealRefused("bad_key");
  if (input.keyId !== (await sealingKeyId(controllerRaw))) throw new SealRefused("key_mismatch");
  if (
    typeof input.controllerId !== "string" ||
    !CONTROLLER_ID_PATTERN.test(input.controllerId) ||
    typeof input.provider !== "string" ||
    !PROVIDER_PATTERN.test(input.provider)
  )
    throw new SealRefused("bad_target");
  checkLogin(input.login);

  let controller: CryptoKey;
  let ephemeralPrivate: CryptoKey;
  let ephemeralPublic: Uint8Array;
  // The browser's X25519 first, so a browser without it says so, then the
  // controller's key, which a browser that has X25519 can only refuse as bad.
  try {
    const pair = (await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
    ephemeralPrivate = pair.privateKey;
    ephemeralPublic = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  } catch {
    throw new SealRefused("unsupported");
  }
  try {
    controller = await subtle.importKey("raw", controllerRaw as BufferSource, { name: "X25519" }, false, []);
  } catch {
    throw new SealRefused("bad_key");
  }

  // A low-order controller key gives an all-zero secret (or the browser
  // refuses it outright): either way it isn't a key we seal to.
  let shared: Uint8Array;
  try {
    shared = new Uint8Array(
      await subtle.deriveBits({ name: "X25519", public: controller }, ephemeralPrivate, 256),
    );
  } catch {
    throw new SealRefused("bad_key");
  }
  if (shared.every((byte) => byte === 0)) throw new SealRefused("bad_key");
  const salt = new Uint8Array(64);
  salt.set(ephemeralPublic, 0);
  salt.set(controllerRaw, 32);
  const hkdfKey = await subtle.importKey("raw", shared as BufferSource, "HKDF", false, ["deriveKey"]);
  shared.fill(0);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: new TextEncoder().encode(INFO) as BufferSource },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ kind: input.login.kind, credential: input.login.credential }),
  );
  let ciphertext: Uint8Array;
  try {
    ciphertext = new Uint8Array(
      await subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce as BufferSource,
          additionalData: new TextEncoder().encode(
            `switch-provider-login-v1\n${input.controllerId}\n${input.provider}`,
          ) as BufferSource,
          tagLength: 128,
        },
        key,
        plaintext as BufferSource,
      ),
    );
  } finally {
    plaintext.fill(0);
  }
  return {
    alg: SEALED_LOGIN_ALG,
    key_id: input.keyId,
    ephemeral_key: toBase64(ephemeralPublic),
    nonce: toBase64(nonce),
    ciphertext: toBase64(ciphertext),
  };
}
