import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Controller, ProviderStatus } from "../../data/management";
import { answer } from "../../test/signedIn";
import AIProvidersPage from "./AIProvidersPage";
import { providersQueryClient } from "./DeviceProviders";

function report(provider: string, extra: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    provider,
    installed: true,
    version: "1.0.0",
    auth: "ok",
    auth_source: "local",
    checked_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    ...extra,
  };
}

function device(id: string, providers: ProviderStatus[], extra: Partial<Controller> = {}): Controller {
  return {
    id,
    name: id,
    description: null,
    kind: "daemon",
    platform: null,
    version: "0.1.1",
    state: "online",
    last_seen_at: null,
    connection: null,
    status: { providers } as Controller["status"],
    release: null,
    assignment_revision: 1,
    created_at: "2026-11-01T10:00:00Z",
    revoked_at: null,
    can_edit: true,
    can_remove: true,
    public_key: null,
    ...extra,
  };
}

const PROVIDERS = {
  providers: [
    { id: "claude", label: "Claude Code", advanced_fields: [] },
    { id: "codex", label: "Codex", advanced_fields: [] },
  ],
};

/** A device's X25519 key, as its controller registers it. */
async function sealingKey(): Promise<NonNullable<Controller["public_key"]>> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { alg: "X25519", key: btoa(String.fromCharCode(...raw)), key_id: "k1" };
}

function renderPage() {
  render(
    <MemoryRouter>
      <AIProvidersPage />
    </MemoryRouter>,
  );
}

/** A provider's row, by the name after its icon (whose artwork carries a title of its own). */
function providerRow(name: string): HTMLElement {
  const row = screen.getAllByRole("row").find((each) => each.querySelector("td")?.textContent?.endsWith(name));
  if (!row) throw new Error(`No row for ${name}`);
  return row;
}

describe("AIProvidersPage", () => {
  beforeEach(() => {
    vi.stubGlobal("isSecureContext", true);
  });

  afterEach(() => {
    cleanup();
    providersQueryClient.clear();
    vi.unstubAllGlobals();
  });

  it("lists each of your devices with its providers, signed in or not, leaving removed ones out", async () => {
    answer({
      "GET /management/controllers": [
        200,
        [
          device("laptop", [report("claude"), report("codex", { auth: "missing" }), report("kiro", { installed: false, version: null })]),
          device("old-box", [], { state: "revoked" }),
        ],
      ],
      "GET /management/providers": [200, PROVIDERS],
      "GET /hosted-machines": [200, { available: false, machines: [] }],
    });
    renderPage();

    expect(await screen.findByRole("heading", { name: "laptop" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "old-box" })).toBeNull();
    await waitFor(() => expect(providerRow("Claude Code").textContent).toContain("Signed in"));
    expect(providerRow("Claude Code").textContent).toContain("On the device");
    expect(providerRow("Claude Code").textContent).toContain("10 min ago");
    expect(providerRow("Codex").textContent).toContain("Not signed in");
    expect(providerRow("kiro").textContent).toContain("Not installed");
    expect(screen.getByText(/Switch can't install a provider on laptop/)).toBeTruthy();
  });

  it("rechecks a provider and shows when the device last checked it", async () => {
    const calls = answer({
      "GET /management/controllers": [
        [200, [device("laptop", [report("codex")])]],
        [200, [device("laptop", [report("codex", { checked_at: new Date().toISOString() })])]],
      ],
      "GET /management/providers": [200, PROVIDERS],
      "GET /hosted-machines": [200, { available: false, machines: [] }],
      "POST /management/operations": [201, { id: "op1" }],
      "GET /management/operations": [200, [{ id: "op1", state: "succeeded", result: { outcome: "ok" } }]],
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Recheck Codex on laptop" }));

    await waitFor(() => expect(providerRow("Codex").textContent).toContain("Just now"));
    expect(calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([
      { controller_id: "laptop", agent_id: null, kind: "provider.recheck", params: { provider: "codex" } },
    ]);
  });

  it("says why a device could not check a provider, in its own words", async () => {
    answer({
      "GET /management/controllers": [200, [device("laptop", [report("codex")])]],
      "GET /management/providers": [200, PROVIDERS],
      "GET /hosted-machines": [200, { available: false, machines: [] }],
      "POST /management/operations": [201, { id: "op1" }],
      "GET /management/operations": [200, [{ id: "op1", state: "expired", result: null }]],
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Recheck Codex on laptop" }));
    expect(await screen.findByText("laptop did not check the provider in time. Is it online?")).toBeTruthy();
  });

  it("gives a device a login sealed in the browser for it alone, and says the provider signs in", async () => {
    const key = await sealingKey();
    const calls = answer({
      "GET /management/controllers": [200, [device("laptop", [report("codex", { auth: "missing" })], { public_key: key })]],
      "GET /management/providers": [200, PROVIDERS],
      "GET /hosted-machines": [200, { available: false, machines: [] }],
      "PUT /management/controllers/laptop/provider-logins/codex": [200, { operation: { id: "op7" } }],
      "GET /management/operations": [200, [{ id: "op7", state: "succeeded", result: { outcome: "ok" } }]],
    });
    renderPage();

    await waitFor(() => fireEvent.click(within(providerRow("Codex")).getByRole("button", { name: /Give login/ })));
    const form = screen.getByRole("group", { name: "" });
    fireEvent.click(within(form).getByLabelText("API key", { selector: "button" }));
    fireEvent.change(within(form).getByLabelText("API key", { selector: "input" }), {
      target: { value: "sk-not-real" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Give login" }));

    expect(await screen.findByText("Codex signs in on laptop.")).toBeTruthy();
    const given = calls.find((call) => call.method === "PUT");
    const sealed = (given?.body as { sealed: Record<string, string> }).sealed;
    expect(sealed.alg).toBe("X25519-HKDF-SHA256-A256GCM");
    expect(JSON.stringify(sealed)).not.toContain("sk-not-real");
  });

  it("signs Claude Code in with a browser first, on the device itself", async () => {
    const url = "https://claude.ai/oauth/authorize?code=true";
    const open = { id: "op8", state: "claimed", result: null, progress: { message: "", sign_in: { url, needs_code: true } } };
    const calls = answer({
      "GET /management/controllers": [200, [device("laptop", [report("claude", { auth: "missing" })], { public_key: await sealingKey() })]],
      "GET /management/providers": [200, PROVIDERS],
      "GET /hosted-machines": [200, { available: false, machines: [] }],
      "POST /management/controllers/laptop/provider-logins/claude/browser": [200, { operation: { id: "op8" } }],
      "GET /management/operations": [
        [200, [{ ...open, state: "pending", progress: null }]],
        [200, [open]],
        [200, [open]],
        [200, [{ id: "op8", state: "succeeded", result: { outcome: "succeeded" }, progress: null }]],
      ],
      "POST /management/operations/op8/sign-in-code": [200, { ok: true }],
    });
    renderPage();

    await waitFor(() => fireEvent.click(within(providerRow("Claude Code")).getByRole("button", { name: /Give login/ })));
    const form = screen.getByRole("group", { name: "" });
    expect(within(form).getByLabelText("Sign in with browser").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(form).getByRole("button", { name: "Start sign-in" }));

    const page = await screen.findByRole("link", { name: /Open sign-in page/ }, { timeout: 5000 });
    expect(page.getAttribute("href")).toBe(url);
    fireEvent.change(screen.getByLabelText("Sign-in code"), { target: { value: "abc#def" } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByText("Signed in: Claude Code signs in on laptop.", {}, { timeout: 8000 })).toBeTruthy();
    expect(calls.find((call) => call.path.endsWith("/sign-in-code"))?.body).toEqual({ code: "abc#def" });
  });

  it("offers a browser sign-in on a Switch Cloud device for Claude Code and Codex only", async () => {
    answer({
      "GET /management/controllers": [
        200,
        [
          device("cloud-1", [report("claude", { auth: "missing" }), report("codex", { auth: "missing" })], {
            kind: "ec2",
            public_key: await sealingKey(),
          }),
        ],
      ],
      "GET /management/providers": [200, PROVIDERS],
      "GET /hosted-machines": [200, { available: true, machines: [] }],
    });
    renderPage();
    await waitFor(() => fireEvent.click(within(providerRow("Claude Code")).getByRole("button", { name: /Give login/ })));
    expect(screen.getByLabelText("Sign in with browser").getAttribute("aria-pressed")).toBe("true");
    cleanup();

    renderPage();
    await waitFor(() => fireEvent.click(within(providerRow("Codex")).getByRole("button", { name: /Give login/ })));
    expect(screen.getByLabelText("Sign in with browser").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("API key")).toBeTruthy();
  });

  it("offers no login where the device keeps no key to seal one to, or is offline", async () => {
    answer({
      "GET /management/controllers": [
        200,
        [device("laptop", [report("codex")]), device("desk", [report("claude")], { state: "offline", public_key: await sealingKey() })],
      ],
      "GET /management/providers": [200, PROVIDERS],
      "GET /hosted-machines": [200, { available: false, machines: [] }],
    });
    renderPage();

    await screen.findByRole("heading", { name: "desk" });
    expect(screen.queryByRole("button", { name: /Give login/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Recheck Claude Code on desk" })).toBeNull();
    expect(screen.getByRole("button", { name: "Recheck Codex on laptop" })).toBeTruthy();
  });

  it("leads to setting up Switch Cloud where there is one to have and you have none yet", async () => {
    answer({
      "GET /management/controllers": [200, []],
      "GET /management/providers": [200, PROVIDERS],
      "GET /hosted-machines": [200, { available: true, machines: [] }],
    });
    renderPage();

    expect((await screen.findByRole("link", { name: "Set up Switch Cloud" })).getAttribute("href")).toBe("/get-started");
    expect(screen.queryByText("You have no devices yet")).toBeNull();
  });

  it("shows your Switch Cloud device by the product's name, with its providers", async () => {
    answer({
      "GET /management/controllers": [200, [device("cloud-1", [report("claude")], { kind: "ec2", name: "Switch cloud" })]],
      "GET /management/providers": [200, PROVIDERS],
      "GET /hosted-machines": [200, { available: true, machines: [] }],
    });
    renderPage();

    expect(await screen.findByRole("heading", { name: "Switch Cloud" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Set up Switch Cloud" })).toBeNull();
    expect(screen.getByRole("button", { name: "Recheck Claude Code on Switch Cloud" })).toBeTruthy();
  });

  it("says plainly when your devices can't be loaded", async () => {
    answer({
      "GET /management/controllers": [503, { error: { code: "unavailable", message: "Switch is restarting.", retryable: true } }],
      "GET /management/providers": [200, PROVIDERS],
      "GET /hosted-machines": [200, { available: false, machines: [] }],
    });
    renderPage();

    expect(await screen.findByText("Couldn't load your devices: Switch is restarting.", {}, { timeout: 5000 })).toBeTruthy();
  });
});
