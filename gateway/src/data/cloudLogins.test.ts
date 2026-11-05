// @vitest-environment node
// Node's WebCrypto, as the browsers have it: the login is really sealed here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boxController, giveCloudLogin, waitForOperation, withdrawCloudLogin } from "./cloudLogins";
import { SealRefused, rawKey, sealingKeyId, toBase64 } from "./sealLogin";

const subtle = globalThis.crypto.subtle;
const MARKER = "sk-ant-MARKER-4c1e9b";

const BOX = {
  machine_id: "m-1",
  state: "ready",
  desired_state: "running",
  stop_reason: null,
  sleeping: false,
  revision: 2,
  agents: [],
  controller_id: "box-ctl",
  backend: "box",
};

type Seen = { url: string; method: string; body: string | undefined };
let seen: Seen[];
let controllers: Record<string, unknown>[];
let machines: Record<string, unknown>[];
let operations: Record<string, unknown>[];
let boxKeys: CryptoKeyPair;

async function keyOf(pair: CryptoKeyPair) {
  const key = toBase64(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
  return { alg: "X25519", key, key_id: await sealingKeyId(rawKey(key)!) };
}

const ctl = (over: Record<string, unknown>) => ({
  id: "box-ctl",
  name: "Switch cloud",
  kind: "ec2",
  state: "online",
  revoked_at: null,
  ...over,
});

beforeEach(async () => {
  seen = [];
  boxKeys = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const macKeys = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  machines = [BOX];
  operations = [];
  controllers = [
    // The person's own Mac, with a key of its own and labelled like a cloud machine.
    ctl({ id: "my-mac", name: "My Mac", public_key: await keyOf(macKeys) }),
    ctl({ public_key: await keyOf(boxKeys) }),
  ];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    seen.push({ url, method, body: init?.body ? String(init.body) : undefined });
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url === "/gateway/hosted-machines") return ok({ available: true, machines });
    if (url === "/gateway/management/controllers") return ok(controllers);
    if (url.includes("/provider-logins/") && method === "PUT")
      return ok({ login: {}, operation: { id: "op-1", state: "pending" } });
    if (url.includes("/provider-logins/") && method === "DELETE") return ok({ ok: true });
    if (url.startsWith("/gateway/management/operations")) return ok(operations);
    return new Response("{}", { status: 404 });
  });
});

afterEach(() => vi.restoreAllMocks());

async function open(sealed: { ephemeral_key: string; nonce: string; ciphertext: string }, controllerId: string, provider: string) {
  const b = (v: string) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
  const pub = new Uint8Array(await subtle.exportKey("raw", boxKeys.publicKey));
  const eph = await subtle.importKey("raw", b(sealed.ephemeral_key), { name: "X25519" }, false, []);
  const shared = await subtle.deriveBits({ name: "X25519", public: eph }, boxKeys.privateKey, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array([...b(sealed.ephemeral_key), ...pub]), info: new TextEncoder().encode("switch provider login v1") },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plain = await subtle.decrypt(
    { name: "AES-GCM", iv: b(sealed.nonce), additionalData: new TextEncoder().encode(`switch-provider-login-v1\n${controllerId}\n${provider}`) },
    key,
    b(sealed.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

describe("which controller a login is sealed to", () => {
  it("is only the box's own, by hosted-machines' controller_id, never the Mac", async () => {
    expect((await boxController()).id).toBe("box-ctl");
  });

  it.each([
    ["no box", () => (machines = [])],
    ["a box not enrolled yet", () => (machines = [{ ...BOX, controller_id: null }])],
    ["a v1 machine", () => (machines = [{ ...BOX, backend: "vm" }])],
    ["a revoked controller", () => (controllers[1] = { ...controllers[1], revoked_at: "2026-11-05T00:00:00Z" })],
    ["a controller with no key", () => (controllers[1] = { ...controllers[1], public_key: null })],
    ["a key that isn't X25519", () => (controllers[1] = { ...controllers[1], public_key: { alg: "RSA", key: "x", key_id: "y" } })],
    ["the box's controller missing from the list", () => (controllers = [controllers[0]])],
  ])("refuses with %s, and sends nothing", async (_name, change) => {
    change();
    await expect(giveCloudLogin("claude", { kind: "api-key", credential: MARKER })).rejects.toBeInstanceOf(SealRefused);
    expect(seen.some((s) => s.method === "PUT")).toBe(false);
  });

  it("refuses a key whose id doesn't match it, and sends nothing", async () => {
    controllers[1] = { ...controllers[1], public_key: { ...(controllers[1].public_key as object), key_id: "0000000000000000" } };
    await expect(giveCloudLogin("claude", { kind: "api-key", credential: MARKER })).rejects.toMatchObject({ code: "key_mismatch" });
    expect(seen.some((s) => s.method === "PUT")).toBe(false);
  });
});

describe("giving a login", () => {
  it("sends only the sealed blob to the box's controller, which opens it", async () => {
    const answer = await giveCloudLogin("claude", { kind: "api-key", credential: MARKER });
    expect(answer).toEqual({ controllerId: "box-ctl", operation: { id: "op-1", state: "pending" } });
    const put = seen.find((s) => s.method === "PUT")!;
    expect(put.url).toBe("/gateway/management/controllers/box-ctl/provider-logins/claude");
    const body = JSON.parse(put.body!);
    expect(Object.keys(body)).toEqual(["sealed"]);
    expect(Object.keys(body.sealed).sort()).toEqual(["alg", "ciphertext", "ephemeral_key", "key_id", "nonce"]);
    // Never in the clear: not in any request, URL or body.
    expect(JSON.stringify(seen)).not.toContain(MARKER);
    expect(await open(body.sealed, "box-ctl", "claude")).toEqual({ kind: "api-key", credential: MARKER });
  });

  it("withdraws from the box's controller", async () => {
    expect(await withdrawCloudLogin("codex")).toEqual({ controllerId: "box-ctl" });
    expect(seen.find((s) => s.method === "DELETE")!.url).toBe(
      "/gateway/management/controllers/box-ctl/provider-logins/codex",
    );
  });
});

describe("how the box took it", () => {
  const sleep = vi.fn(async () => {});

  it("follows the operation to its end", async () => {
    operations = [{ id: "op-1", kind: "provider.login", state: "claimed", params: {}, created_at: new Date().toISOString() }];
    let polls = 0;
    sleep.mockImplementation(async () => {
      if (++polls === 2) operations = [{ ...operations[0], state: "succeeded" }];
    });
    expect(await waitForOperation("box-ctl", { id: "op-1" }, { sleep, waitMs: 60_000 })).toBe("succeeded");
  });

  it("finds a withdraw's recheck by kind, provider and time", async () => {
    const since = Date.now();
    operations = [
      { id: "old", kind: "provider.recheck", state: "failed", params: { provider: "codex" }, created_at: new Date(since - 600_000).toISOString() },
      { id: "new", kind: "provider.recheck", state: "succeeded", params: { provider: "codex" }, created_at: new Date(since + 10).toISOString() },
      { id: "other", kind: "provider.recheck", state: "failed", params: { provider: "claude" }, created_at: new Date(since + 20).toISOString() },
    ];
    expect(await waitForOperation("box-ctl", { kind: "provider.recheck", provider: "codex", since }, { sleep })).toBe("succeeded");
  });

  it("gives up with null when it doesn't end in time", async () => {
    operations = [{ id: "op-1", kind: "provider.login", state: "pending", params: {}, created_at: new Date().toISOString() }];
    expect(await waitForOperation("box-ctl", { id: "op-1" }, { sleep, waitMs: 0 })).toBeNull();
  });
});
