import { afterEach, describe, expect, it } from "vitest";
import type { Session, TenantMembership } from "./api";
import {
  appView,
  canAdminTenant,
  clearPendingInvite,
  inviteTokenFrom,
  inviteUrl,
  ownsTenant,
  readPendingInvite,
  storePendingInvite,
} from "./sessionState";

const acme: TenantMembership = { id: "t1", slug: "acme", name: "Acme", role: "member" };

function session(overrides: Partial<Session> = {}): Session {
  return {
    user: { id: "u1", name: "Ada", email: "ada@example.com", is_operator: false },
    tenant: acme,
    tenants: [acme],
    state: "ready",
    can_create_workspace: true,
    ...overrides,
  };
}

describe("appView", () => {
  it("is signed out without a session, pending invite or not", () => {
    expect(appView(null, null)).toBe("signed_out");
    expect(appView(null, "tok")).toBe("signed_out");
  });

  it("follows the server's state when there is no pending invite", () => {
    expect(appView(session(), null)).toBe("ready");
    expect(appView(session({ state: "needs_workspace", tenant: null, tenants: [] }), null)).toBe(
      "needs_workspace",
    );
    expect(appView(session({ state: "needs_selection", tenant: null }), null)).toBe(
      "needs_selection",
    );
  });

  it("puts a pending invite ahead of every signed-in state", () => {
    for (const state of ["ready", "needs_workspace", "needs_selection"] as const) {
      expect(appView(session({ state }), "tok")).toBe("accept_invite");
    }
  });
});

describe("canAdminTenant and ownsTenant", () => {
  it("follows the workspace role", () => {
    expect(canAdminTenant(session())).toBe(false);
    expect(canAdminTenant(session({ tenant: { ...acme, role: "admin" } }))).toBe(true);
    expect(canAdminTenant(session({ tenant: { ...acme, role: "owner" } }))).toBe(true);
    expect(ownsTenant(session({ tenant: { ...acme, role: "admin" } }))).toBe(false);
    expect(ownsTenant(session({ tenant: { ...acme, role: "owner" } }))).toBe(true);
  });

  it("grants both to an operator whatever the role", () => {
    const operator = session({
      user: { id: "u1", name: "Op", email: "op@example.com", is_operator: true },
    });
    expect(canAdminTenant(operator)).toBe(true);
    expect(ownsTenant(operator)).toBe(true);
  });

  it("grants neither with no session or no workspace", () => {
    expect(canAdminTenant(null)).toBe(false);
    expect(ownsTenant(null)).toBe(false);
    expect(canAdminTenant(session({ tenant: null, state: "needs_workspace" }))).toBe(false);
  });
});

describe("invite tokens", () => {
  afterEach(() => clearPendingInvite());

  it("reads a token from a full link or a bare token", () => {
    expect(inviteTokenFrom("https://switch.example.com/invite?token=abc123")).toBe("abc123");
    expect(inviteTokenFrom("  abc123  ")).toBe("abc123");
  });

  it("finds none in empty input, a link without one, or prose", () => {
    expect(inviteTokenFrom("   ")).toBeNull();
    expect(inviteTokenFrom("https://switch.example.com/invite")).toBeNull();
    expect(inviteTokenFrom("please let me in")).toBeNull();
  });

  it("round-trips through the link it builds", () => {
    const link = inviteUrl("https://switch.example.com", "a+b/c=");
    expect(inviteTokenFrom(link)).toBe("a+b/c=");
  });

  it("keeps a pending invite in session storage until cleared", () => {
    expect(readPendingInvite()).toBeNull();
    storePendingInvite("tok");
    expect(readPendingInvite()).toBe("tok");
    clearPendingInvite();
    expect(readPendingInvite()).toBeNull();
  });
});
