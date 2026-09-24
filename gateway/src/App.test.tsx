import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "./App";
import type { Session, TenantMembership } from "./data/api";
import { AuthProvider } from "./data/AuthContext";
import { clearPendingInvite, storePendingInvite } from "./data/sessionState";

const acme: TenantMembership = { id: "t1", slug: "acme", name: "Acme", role: "owner" };
const beta: TenantMembership = { id: "t2", slug: "beta", name: "Beta Co", role: "member" };

function session(overrides: Partial<Session>): Session {
  return {
    user: { id: "u1", name: "Ada", email: "ada@example.com", is_operator: false },
    tenant: null,
    tenants: [],
    state: "needs_workspace",
    can_create_workspace: true,
    ...overrides,
  };
}

/** Every request answers from `routes` by path; anything else is a 404 so an
 * unexpected call shows up as a failure rather than hanging. */
function mockFetch(routes: Record<string, [number, unknown]>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace(/^\/gateway/, "").split("?")[0];
      const [status, body] = routes[path] ?? [404, { detail: `unmocked ${path}` }];
      return new Response(JSON.stringify(body), { status });
    }),
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

const authConfig = {
  oidc_enabled: true,
  oidc_provider_label: "Example SSO",
  password_login_enabled: true,
  signup_mode: "open",
};

describe("AppRoutes", () => {
  afterEach(() => {
    cleanup();
    clearPendingInvite();
    vi.unstubAllGlobals();
  });

  it("sends a signed-out visitor to sign in", async () => {
    mockFetch({ "/auth/session": [401, { detail: "Not authenticated" }], "/auth/config": [200, authConfig] });
    renderAt("/rooms");
    expect(await screen.findByText("Switch Gateway")).toBeTruthy();
    expect(
      await screen.findByText("Sign in with Example SSO to create a workspace or join one."),
    ).toBeTruthy();
  });

  it("keeps an invite link through sign-in", async () => {
    mockFetch({ "/auth/session": [401, { detail: "Not authenticated" }], "/auth/config": [200, authConfig] });
    renderAt("/invite?token=abc");
    expect(await screen.findByText("Sign in to accept your invitation.")).toBeTruthy();
    expect(window.sessionStorage.getItem("switch.pendingInvite")).toBe("abc");
  });

  it("offers to create a workspace to someone in none", async () => {
    mockFetch({ "/auth/session": [200, session({})] });
    renderAt("/");
    expect(await screen.findByText("Welcome to Switch")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create workspace" })).toBeTruthy();
  });

  it("only offers an invite when workspaces cannot be created", async () => {
    mockFetch({ "/auth/session": [200, session({ can_create_workspace: false })] });
    renderAt("/");
    expect(await screen.findByText(/Ask a workspace admin for an invite link/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create workspace" })).toBeNull();
  });

  it("asks someone in several workspaces to choose", async () => {
    mockFetch({
      "/auth/session": [200, session({ state: "needs_selection", tenants: [acme, beta] })],
    });
    renderAt("/rooms");
    expect(await screen.findByText("Choose a workspace")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("Beta Co")).toBeTruthy();
  });

  it("opens the app in the current workspace", async () => {
    mockFetch({
      "/auth/session": [200, session({ state: "ready", tenant: acme, tenants: [acme, beta] })],
    });
    renderAt("/workspace");
    expect(await screen.findByRole("heading", { name: "Acme" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Workspace/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Users/ })).toBeNull();
  });

  it("puts a pending invite before everything else", async () => {
    storePendingInvite("abc");
    mockFetch({
      "/auth/session": [200, session({ state: "ready", tenant: acme, tenants: [acme] })],
    });
    renderAt("/rooms");
    expect(await screen.findByText("Join a workspace")).toBeTruthy();
  });

  it("says so when the session cannot be read, instead of showing sign-in", async () => {
    mockFetch({ "/auth/session": [500, { detail: "database unavailable" }] });
    renderAt("/rooms");
    expect(
      await screen.findByText(/Could not load your session: database unavailable/),
    ).toBeTruthy();
    expect(screen.queryByText("Switch Gateway")).toBeNull();
  });
});
