// @vitest-environment node
// Node's WebCrypto: the same API the browsers have (X25519, HKDF, AES-GCM).
import { describe, expect, it, vi } from "vitest";
import {
  type ProviderLogin,
  rawKey,
  SEALED_LOGIN_ALG,
  type SealedLogin,
  SealRefused,
  canSeal,
  sealLogin,
  sealingKeyId,
  toBase64,
} from "./sealLogin";
import { VertexKeyRefused, vertexCredential } from "./vertexLogin";

const subtle = globalThis.crypto.subtle;

/**
 * A fixed vector made with Node's own `node:crypto` (`createCipheriv`,
 * `hkdfSync`, `diffieHellman`), the primitives `sealed-login.ts` uses, from
 * these fixed keys and nonce. Not real keys.
 */
const VECTOR = {
  controllerPrivate: "qKurq6urq6urq6urq6urq6urq6urq6urq6urq6urq2s=",
  controllerPublic: "43EthRoOXXm4McXjSrIrQaGYFx3iCbi4+sojoRxiSFk=",
  keyId: "bd7381eab08d2d62",
  ephemeralPrivate: "WHZUMhD+3LqYdlQyEP7cuph2VDIQ/ty6mHZUMhD+3Eg=",
  ephemeralPublic: "ZdRTvQjqrpZM+ouJIV8VXOc1y19B0bu7x19CdSWG5TQ=",
  nonce: "AQIDBAUGBwgJCgsM",
  controllerId: "c0ffee00-0000-4000-8000-000000000001",
  provider: "claude",
  login: { kind: "api-key", credential: "sk-test-VECTOR-not-a-real-key" } as ProviderLogin,
  ciphertext:
    "jYvSEs5W0sGewTylNVkgyoT43Vb9lwIPtnv6sHVnfDeqlsd98uSr5I5grZPNE2MPPj0kOSNPvZcOxXXTi5OBocg/Wok8GF3z0dv/J5Nn7A==",
};

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** A controller keypair, as a box's controller holds one. */
async function controller() {
  const pair = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicKey = toBase64(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
  return { pair, publicKey, keyId: await sealingKeyId(rawKey(publicKey)!) };
}

/** Opens a sealed login as the controller does (`openProviderLogin`), with WebCrypto. */
async function open(
  privateKey: CryptoKey,
  publicKey: string,
  controllerId: string,
  provider: string,
  sealed: SealedLogin,
): Promise<ProviderLogin> {
  const ephemeral = await subtle.importKey("raw", bytes(sealed.ephemeral_key), { name: "X25519" }, false, []);
  const shared = await subtle.deriveBits({ name: "X25519", public: ephemeral }, privateKey, 256);
  const salt = new Uint8Array([...bytes(sealed.ephemeral_key), ...bytes(publicKey)]);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("switch provider login v1") },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plain = await subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes(sealed.nonce),
      additionalData: new TextEncoder().encode(`switch-provider-login-v1\n${controllerId}\n${provider}`),
      tagLength: 128,
    },
    key,
    bytes(sealed.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as ProviderLogin;
}

describe("the wire format", () => {
  it("matches Node byte for byte for a fixed key and nonce", async () => {
    // sealLogin has no test hook: the fixed ephemeral key and nonce come in
    // through WebCrypto itself, here and only here.
    const pkcs8 = new Uint8Array(48);
    pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);
    pkcs8.set(bytes(VECTOR.ephemeralPrivate), 16);
    const fixedPair = {
      privateKey: await subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, false, ["deriveBits"]),
      publicKey: await subtle.importKey("raw", bytes(VECTOR.ephemeralPublic), { name: "X25519" }, true, []),
    };
    const keys = vi.spyOn(subtle, "generateKey").mockResolvedValue(fixedPair as never);
    const random = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        (array as unknown as Uint8Array).set(bytes(VECTOR.nonce));
        return array;
      });
    try {
      const sealed = await sealLogin({
        publicKey: VECTOR.controllerPublic,
        keyId: VECTOR.keyId,
        controllerId: VECTOR.controllerId,
        provider: VECTOR.provider,
        login: VECTOR.login,
      });
      expect(sealed).toEqual({
        alg: SEALED_LOGIN_ALG,
        key_id: VECTOR.keyId,
        ephemeral_key: VECTOR.ephemeralPublic,
        nonce: VECTOR.nonce,
        ciphertext: VECTOR.ciphertext,
      });
    } finally {
      keys.mockRestore();
      random.mockRestore();
    }
  });

  it("takes no second argument: there's no way to fix its key or nonce", () => {
    expect(sealLogin.length).toBe(1);
  });

  it("works out the key id as Node does", async () => {
    expect(await sealingKeyId(rawKey(VECTOR.controllerPublic)!)).toBe(VECTOR.keyId);
  });

  it.each(["api-key", "setup-token", "auth-json", "vertex"] as const)(
    "a %s login opens with the controller's key, and a fresh ephemeral key and nonce each time",
    async (kind) => {
      const box = await controller();
      const login = { kind, credential: `secret-${kind}` };
      const input = { publicKey: box.publicKey, keyId: box.keyId, controllerId: "ctl-1", provider: "claude", login };
      const first = await sealLogin(input);
      const second = await sealLogin(input);
      expect(await open(box.pair.privateKey, box.publicKey, "ctl-1", "claude", first)).toEqual(login);
      expect(first.ephemeral_key).not.toBe(second.ephemeral_key);
      expect(first.nonce).not.toBe(second.nonce);
      expect(Object.keys(first).sort()).toEqual(["alg", "ciphertext", "ephemeral_key", "key_id", "nonce"]);
    },
  );
});

describe("sealed for one controller and provider only", () => {
  it.each([
    ["another controller", "ctl-2", "claude"],
    ["another provider", "ctl-1", "codex"],
  ])("doesn't open for %s", async (_name, controllerId, provider) => {
    const box = await controller();
    const sealed = await sealLogin({
      publicKey: box.publicKey,
      keyId: box.keyId,
      controllerId: "ctl-1",
      provider: "claude",
      login: { kind: "api-key", credential: "k" },
    });
    await expect(open(box.pair.privateKey, box.publicKey, controllerId, provider, sealed)).rejects.toThrow();
  });

  it("doesn't open with one bit flipped", async () => {
    const box = await controller();
    const sealed = await sealLogin({
      publicKey: box.publicKey,
      keyId: box.keyId,
      controllerId: "ctl-1",
      provider: "claude",
      login: { kind: "api-key", credential: "k" },
    });
    const body = bytes(sealed.ciphertext);
    body[0] ^= 1;
    await expect(
      open(box.pair.privateKey, box.publicKey, "ctl-1", "claude", { ...sealed, ciphertext: toBase64(body) }),
    ).rejects.toThrow();
  });
});

describe("refusals: nothing is sealed", () => {
  const login: ProviderLogin = { kind: "api-key", credential: "k" };

  it.each([
    ["not base64", "not a key!"],
    ["too short", toBase64(new Uint8Array(31))],
    ["too long", toBase64(new Uint8Array(33))],
    ["not canonical", "43EthRoOXXm4McXjSrIrQaGYFx3iCbi4+sojoRxiSFl="],
  ])("a key that is %s", async (_name, publicKey) => {
    await expect(
      sealLogin({ publicKey, keyId: "x", controllerId: "ctl-1", provider: "claude", login }),
    ).rejects.toMatchObject({ code: "bad_key" });
  });

  it.each([
    ["all zeros (u = 0)", new Uint8Array(32)],
    ["one (u = 1)", Uint8Array.from({ length: 32 }, (_, at) => (at === 0 ? 1 : 0))],
  ])("a low-order key: %s", async (_name, raw) => {
    const publicKey = toBase64(raw);
    await expect(
      sealLogin({ publicKey, keyId: await sealingKeyId(raw), controllerId: "ctl-1", provider: "claude", login }),
    ).rejects.toMatchObject({ code: "bad_key" });
  });

  it.each([
    ["an empty controller id", "", "claude"],
    ["a controller id with a newline", "ctl-1\nclaude", "claude"],
    ["a controller id over 128 characters", "c".repeat(129), "claude"],
    ["an empty provider", "ctl-1", ""],
    ["a provider with a newline", "ctl-1", "claude\nx"],
    ["a provider in capitals", "ctl-1", "Claude"],
  ])("%s", async (_name, controllerId, provider) => {
    const box = await controller();
    await expect(
      sealLogin({ publicKey: box.publicKey, keyId: box.keyId, controllerId, provider, login }),
    ).rejects.toMatchObject({ code: "bad_target" });
  });

  it("a key whose id doesn't match", async () => {
    const box = await controller();
    await expect(
      sealLogin({ publicKey: box.publicKey, keyId: "0000000000000000", controllerId: "ctl-1", provider: "claude", login }),
    ).rejects.toMatchObject({ code: "key_mismatch" });
  });

  it.each([
    ["an unknown kind", { kind: "password", credential: "k" }],
    ["an empty credential", { kind: "api-key", credential: "" }],
    ["a credential over 16,384 characters", { kind: "api-key", credential: "x".repeat(16385) }],
  ])("a login with %s", async (_name, bad) => {
    const box = await controller();
    await expect(
      sealLogin({
        publicKey: box.publicKey,
        keyId: box.keyId,
        controllerId: "ctl-1",
        provider: "claude",
        login: bad as ProviderLogin,
      }),
    ).rejects.toMatchObject({ code: "bad_login" });
  });

  it("a browser without X25519", async () => {
    const box = await controller();
    const spy = vi.spyOn(subtle, "generateKey").mockRejectedValue(new DOMException("no", "NotSupportedError"));
    try {
      expect(await canSeal()).toBe(false);
      await expect(
        sealLogin({ publicKey: box.publicKey, keyId: box.keyId, controllerId: "ctl-1", provider: "claude", login }),
      ).rejects.toMatchObject({ code: "unsupported" });
    } finally {
      spy.mockRestore();
    }
  });

  it("never says any part of the login in a refusal", async () => {
    const box = await controller();
    const marker = "MARKER-7f3a9c";
    const error = await sealLogin({
      publicKey: box.publicKey,
      keyId: box.keyId,
      controllerId: "ctl-1",
      provider: "claude",
      login: { kind: "nope", credential: marker } as unknown as ProviderLogin,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SealRefused);
    expect(String((error as Error).message)).not.toContain(marker);
    expect(JSON.stringify(error)).not.toContain(marker);
  });
});

describe("the Vertex key file", () => {
  const KEY = {
    type: "service_account",
    project_id: "demo",
    private_key_id: "abc123",
    private_key: "-----BEGIN PRIVATE KEY-----\nMARKER-key\n-----END PRIVATE KEY-----\n",
    client_email: "agent@demo-project.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  };
  const file = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

  it("builds Console's credential, and zero-fills the file", async () => {
    const bytesIn = file(KEY);
    const credential = vertexCredential(bytesIn, " demo-project ", "global");
    expect(JSON.parse(credential)).toEqual({ v: 1, project: "demo-project", region: "global", credentials: KEY });
    expect(bytesIn.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    ["a Google sign-in", { ...KEY, type: "authorized_user" }, "not_service_account"],
    ["another credential type", { ...KEY, type: "external_account" }, "not_service_account"],
    ["no email", { ...KEY, client_email: undefined }, "missing_fields"],
    ["no private key", { ...KEY, private_key: "nope" }, "missing_fields"],
    ["a plain-http token address", { ...KEY, token_uri: "http://x" }, "missing_fields"],
  ])("refuses %s, and still zero-fills the file", (_name, value, code) => {
    const bytesIn = file(value);
    expect(() => vertexCredential(bytesIn, "demo-project", "global")).toThrow(VertexKeyRefused);
    try {
      vertexCredential(file(value), "demo-project", "global");
    } catch (error) {
      expect((error as VertexKeyRefused).code).toBe(code);
      expect((error as Error).message).not.toContain("MARKER");
    }
    expect(bytesIn.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    ["not JSON", new TextEncoder().encode("not json"), "not_json"],
    ["too large", new Uint8Array(64 * 1024 + 1), "too_large"],
  ])("refuses a file that is %s", (_name, bytesIn, code) => {
    expect(() => vertexCredential(bytesIn as Uint8Array, "demo-project", "global")).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it.each([
    ["project", "Bad_Project", "global", "bad_project"],
    ["region", "demo-project", "us east!", "bad_region"],
  ])("refuses a bad %s", (_name, project, region, code) => {
    expect(() => vertexCredential(file(KEY), project, region)).toThrow(expect.objectContaining({ code }));
  });

  it("seals a Vertex credential that opens to the same key", async () => {
    const box = await controller();
    const credential = vertexCredential(file(KEY), "demo-project", "us-east5");
    const sealed = await sealLogin({
      publicKey: box.publicKey,
      keyId: box.keyId,
      controllerId: "ctl-1",
      provider: "claude",
      login: { kind: "vertex", credential },
    });
    const opened = await open(box.pair.privateKey, box.publicKey, "ctl-1", "claude", sealed);
    expect(JSON.parse(opened.credential).credentials).toEqual(KEY);
  });
});

/**
 * Engineer-4's vectors (`eng4-seal-vectors-v1.json`, sha256 a63a018ac2b8…),
 * made with Node and opened by the real `openProviderLogin`: a plain API key,
 * and an auth-json login with non-ASCII text. Test-only keys from public labels.
 */
const NODE_VECTORS = [
  {
    "name": "api-key",
    "publicKey": "ktZe7WNmMHC+rVeoS095CZx8Rg9d7rtzvPa8VRGUDF0=",
    "ephemeralPrivate": "ENmIXLuUfREaW0TlQHDnTrG4ywg19amc2TJTn1qETMQ=",
    "nonce": "4LlQffjWW+qLZQvX",
    "controllerId": "ctrl-test-0001",
    "provider": "claude",
    "login": {
      "kind": "api-key",
      "credential": "sk-test-NOT-A-REAL-KEY"
    },
    "expected": {
      "alg": "X25519-HKDF-SHA256-A256GCM",
      "key_id": "c1fede7e7d831d12",
      "ephemeral_key": "oNmNRicMx0Iu+8N8pnIHvxDiayoblRKJMkfY28z8yzk=",
      "nonce": "4LlQffjWW+qLZQvX",
      "ciphertext": "czAlbcaxteqT0lp1ATTCNJkNLCHcbeTc+GU1Ab6et3o2R7IIN9XSh5S9tSPqyF+C3iQEFrEbuBCzv3iKHLlxfO6yEeLaFxQ3"
    }
  },
  {
    "name": "auth-json unicode",
    "publicKey": "coH6ePipAfZod4QkeGOfrCRQPoFkiNe1MW0y+ddZ2gA=",
    "ephemeralPrivate": "y0dcrILl+27bT6rhhk1+P9nC001frBaeFveR8VCkD8g=",
    "nonce": "UjaGXxwTPp9lGsYF",
    "controllerId": "ctrl-test-0002",
    "provider": "codex",
    "login": {
      "kind": "auth-json",
      "credential": "{\"note\":\"tëst ✓ — not real\"}"
    },
    "expected": {
      "alg": "X25519-HKDF-SHA256-A256GCM",
      "key_id": "a83f453063543d41",
      "ephemeral_key": "FRhstdyAASZkvQ7FcnN/PqweMq9af4y/8/04doZhzA0=",
      "nonce": "UjaGXxwTPp9lGsYF",
      "ciphertext": "IByKSYBvCFrbt5d1JCBSWyjh2UJrNQStKF2n5vaVMJXYKrODttTFHbW9tH8/mvZDnEeLCdfMOqOmSC19c7MERnS7jMXmC+30/yX7qhsEZ12CMDmdps6OHqU="
    }
  }
] as const;

describe("engineer-4's Node vectors", () => {
  it.each(NODE_VECTORS.map((v) => [v.name, v] as const))("%s: matches byte for byte", async (_name, v) => {
    const pkcs8 = new Uint8Array([
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
      ...bytes(v.ephemeralPrivate),
    ]);
    const privateKey = await subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, false, ["deriveBits"]);
    const fixedPair = {
      privateKey,
      publicKey: await subtle.importKey("raw", bytes(v.expected.ephemeral_key), { name: "X25519" }, true, []),
    };
    const keys = vi.spyOn(subtle, "generateKey").mockResolvedValue(fixedPair as never);
    const random = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        (array as unknown as Uint8Array).set(bytes(v.nonce));
        return array;
      });
    try {
      const sealed = await sealLogin({
        publicKey: v.publicKey,
        keyId: v.expected.key_id,
        controllerId: v.controllerId,
        provider: v.provider,
        login: v.login as ProviderLogin,
      });
      expect(sealed).toEqual(v.expected);
    } finally {
      keys.mockRestore();
      random.mockRestore();
    }
  });
});
