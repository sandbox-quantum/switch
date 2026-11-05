import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "./App";
import type { Session, TenantMembership } from "./data/api";
import { AuthProvider } from "./data/AuthContext";
import type { FeatureFlagKey } from "./data/featureFlags";
import { clearPendingInvite, storePendingInvite } from "./data/sessionState";

const acme: TenantMembership = {
  id: "t1",
  slug: "acme",
  name: "Acme",
  role: "admin",
  organization_role: "org_admin",
  organization_id: "o1",
};
const beta: TenantMembership = {
  id: "t2",
  slug: "beta",
  name: "Beta Co",
  role: "member",
  organization_role: "member",
  organization_id: "o2",
};

function session(overrides: Partial<Session>): Session {
  return {
    user: { id: "u1", name: "Ada", email: "ada@example.com", is_operator: false },
    tenant: null,
    tenants: [],
    state: "needs_workspace",
    can_create_workspace: true,
    can_add_workspace: false,
    invite_email_enabled: false,
    ...overrides,
  };
}

type Routes = Record<string, [number, unknown]>;

/** Every request answers from `routes` by path; anything else is a 404 so an
 * unexpected call shows up as a failure rather than hanging. */
function mockFetch(routes: Routes) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace(/^\/gateway/, "").split("?")[0];
      const [status, body] = routes[path] ?? [404, { detail: `unmocked ${path}` }];
      return new Response(JSON.stringify(body), { status });
    }),
  );
}

type Role = "member" | "workspace_admin" | "org_admin" | "operator";

/** What the server answers for someone signed in to Acme as `role`: the
 * session, the deployment's flags, and the workspace with its `administers`. */
function signedInAs(
  role: Role,
  {
    flags = [],
    inOrganization = true,
    tenants = [],
    canDelete = false,
  }: {
    flags?: FeatureFlagKey[];
    inOrganization?: boolean;
    tenants?: TenantMembership[];
    canDelete?: boolean;
  } = {},
): Routes {
  const tenant: TenantMembership = {
    ...acme,
    role: role === "member" ? "member" : "admin",
    organization_role: !inOrganization ? null : role === "org_admin" ? "org_admin" : "member",
    organization_id: inOrganization ? "o1" : null,
  };
  return {
    "/auth/session": [
      200,
      session({
        state: "ready",
        tenant,
        tenants: [tenant, ...tenants],
        user: { id: "u1", name: "Ada", email: "ada@example.com", is_operator: role === "operator" },
      }),
    ],
    "/feature-flags": [200, { flags: flags.map((key) => ({ key, enabled: true })) }],
    "/tenants/current": [
      200,
      {
        id: "t1",
        slug: "acme",
        name: "Acme",
        role: tenant.role,
        administers: role !== "member",
        can_delete: canDelete,
      },
    ],
  };
}

function LocationProbe() {
  const { pathname, search, hash } = useLocation();
  return <output data-testid="location">{`${pathname}${search}${hash}`}</output>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <AppRoutes />
        <LocationProbe />
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function railLabels(): Promise<string[]> {
  const rail = await screen.findByRole("navigation", { name: "Main" });
  return within(rail)
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

async function menuLabels(area: string): Promise<string[]> {
  const menu = await screen.findByRole("navigation", { name: area });
  return within(menu)
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

async function landsOn(path: string) {
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(path));
}

const authConfig = {
  oidc_enabled: true,
  oidc_provider_label: "Example SSO",
  password_login_enabled: true,
  signup_mode: "open",
};

afterEach(() => {
  cleanup();
  clearPendingInvite();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("AppRoutes", () => {
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
    renderAt("/invite#token=abc");
    expect(await screen.findByText("Sign in to accept your invitation.")).toBeTruthy();
    expect(window.sessionStorage.getItem("switch.pendingInvite")).toBe("abc");
  });

  it("offers to create a workspace to someone in none", async () => {
    mockFetch({ "/auth/session": [200, session({})], "/feature-flags": [200, { flags: [] }] });
    renderAt("/");
    expect(await screen.findByText("Welcome to Switch")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create organization" })).toBeTruthy();
  });

  it("only offers an invite when workspaces cannot be created", async () => {
    mockFetch({
      "/auth/session": [200, session({ can_create_workspace: false })],
      "/feature-flags": [200, { flags: [] }],
    });
    renderAt("/");
    expect(await screen.findByText(/Ask a workspace admin for an invite link/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create organization" })).toBeNull();
  });

  it("asks someone in several workspaces to choose", async () => {
    mockFetch({
      "/auth/session": [200, session({ state: "needs_selection", tenants: [acme, beta] })],
      "/feature-flags": [200, { flags: [] }],
    });
    renderAt("/rooms");
    expect(await screen.findByText("Choose a workspace")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("Beta Co")).toBeTruthy();
  });

  it("opens the app in the current workspace", async () => {
    mockFetch(signedInAs("org_admin", { tenants: [beta] }));
    renderAt("/workspace");
    expect(await screen.findByRole("heading", { name: "Acme" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Workspace/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Users/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Connectors/ })).toBeNull();
  });

  it("gives the server's operator Connectors beside Users", async () => {
    mockFetch({
      ...signedInAs("operator", { flags: ["service_connections"] }),
      "/connector-apps": [200, { public_url: "https://switch.example.test", apps: [] }],
    });
    renderAt("/connectors");
    expect(await screen.findByRole("heading", { name: "Connectors" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Users/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Connectors/ })).toBeTruthy();
  });

  it("puts a pending invite before everything else", async () => {
    storePendingInvite("abc");
    mockFetch(signedInAs("org_admin"));
    renderAt("/rooms");
    expect(await screen.findByText("Join a workspace")).toBeTruthy();
  });

  it("drops a pending invite on sign-out, so the next person does not inherit it", async () => {
    storePendingInvite("abc");
    mockFetch({
      ...signedInAs("org_admin"),
      "/auth/logout": [200, { ok: true }],
      "/auth/config": [200, authConfig],
    });
    renderAt("/");
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Switch Gateway")).toBeTruthy();
    expect(window.sessionStorage.getItem("switch.pendingInvite")).toBeNull();
  });

  it("says so when the session cannot be read, instead of showing sign-in", async () => {
    mockFetch({ "/auth/session": [500, { detail: "database unavailable" }] });
    renderAt("/rooms");
    expect(
      await screen.findByText(/Could not load your session: database unavailable/),
    ).toBeTruthy();
    expect(screen.queryByText("Switch Gateway")).toBeNull();
  });

  it("says so when the deployment's flags cannot be read, rather than hiding pages", async () => {
    mockFetch({
      ...signedInAs("member"),
      "/feature-flags": [500, { detail: "flags unavailable" }],
    });
    renderAt("/rooms");
    expect(await screen.findByText(/Could not load your session: flags unavailable/)).toBeTruthy();
  });

  it("says so when the workspace cannot be read, rather than treating everyone as a member", async () => {
    mockFetch({
      ...signedInAs("workspace_admin"),
      "/tenants/current": [500, { detail: "workspace unavailable" }],
    });
    renderAt("/rooms");
    expect(
      await screen.findByText(/Could not load your session: workspace unavailable/),
    ).toBeTruthy();
  });

  it("says there is no page at an address that is none", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/no-such-page");
    expect(await screen.findByText("There's no page here")).toBeTruthy();
  });
});

describe("today's layout", () => {
  it("shows a member the pages anyone in the workspace may open", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/rooms");
    expect(await railLabels()).toEqual([
      "Ecosystem",
      "Rooms",
      "Resources",
      "Agents",
      "Apps",
      "API Keys",
      "Workspace",
      "Organization",
    ]);
  });

  it("leaves Organization off the rail outside an organization", async () => {
    mockFetch(signedInAs("member", { inOrganization: false }));
    renderAt("/rooms");
    expect(await railLabels()).not.toContain("Organization");
  });

  it("gives a workspace admin Usage, and Machines where agent management runs", async () => {
    mockFetch(signedInAs("workspace_admin", { flags: ["agent_management"] }));
    renderAt("/rooms");
    const labels = await railLabels();
    expect(labels).toContain("Usage");
    expect(labels).toContain("Machines");
    expect(labels).not.toContain("All workspaces");
  });

  it("gives the operator the platform's pages", async () => {
    mockFetch(signedInAs("operator"));
    renderAt("/rooms");
    expect((await railLabels()).slice(-4)).toEqual(["Usage", "All workspaces", "Users", "Connectors"]);
  });

  it("refuses a page by its URL to someone who may not open it, and says why", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/usage");
    expect(await screen.findByText("You don't have access to this page")).toBeTruthy();
    expect(screen.getByText("Only this workspace's admins can open this page.")).toBeTruthy();
  });

  it("keeps the operator's pages from everyone else", async () => {
    for (const path of ["/users", "/connectors", "/operator/workspaces"]) {
      mockFetch(signedInAs("org_admin"));
      renderAt(path);
      expect(await screen.findByText("Only the platform operator can open this page.")).toBeTruthy();
      cleanup();
    }
  });

  it("says a page is not turned on, and tells the operator how", async () => {
    mockFetch(signedInAs("operator"));
    renderAt("/machines");
    expect(await screen.findByText("Not turned on")).toBeTruthy();
    expect(screen.getByText("Agent management isn't turned on on this server.")).toBeTruthy();
    expect(
      screen.getByText("An operator turns it on by adding agent_management to FEATURE_FLAGS_ENABLED."),
    ).toBeTruthy();
  });

  it("does not tell anyone but the operator how to turn a page on", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/machines");
    expect(await screen.findByText("Not turned on")).toBeTruthy();
    expect(screen.queryByText(/FEATURE_FLAGS_ENABLED/)).toBeNull();
  });

  it("sends the new layout's URLs back to today's pages, keeping the query and fragment", async () => {
    mockFetch(signedInAs("workspace_admin"));
    renderAt("/settings/api-keys?q=ci#top");
    await landsOn("/registration-keys?q=ci#top");
  });

  it("sends a template's new URL back to it under Resources", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/templates/tpl-1");
    await landsOn("/resources/templates/tpl-1");
  });

  it("has no page at a URL only the new layout has", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/settings/account");
    expect(await screen.findByText("There's no page here")).toBeTruthy();
  });

  it("opens on Rooms", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/");
    await landsOn("/rooms");
  });
});

describe("deleting the workspace", () => {
  it("is offered where the server says the caller may delete it", async () => {
    mockFetch(signedInAs("workspace_admin", { canDelete: true }));
    renderAt("/workspace");
    expect(await screen.findByRole("button", { name: "Delete workspace" })).toBeTruthy();
  });

  it("is not offered to an admin the server will not let delete it, such as an org admin", async () => {
    mockFetch(signedInAs("org_admin", { canDelete: false }));
    renderAt("/workspace");
    expect(await screen.findByRole("heading", { name: "Acme" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete workspace" })).toBeNull();
  });
});

describe("the new layout (gateway_v2)", () => {
  const V2: FeatureFlagKey[] = ["gateway_v2"];

  it("opens on Overview", async () => {
    mockFetch(signedInAs("member", { flags: V2 }));
    renderAt("/");
    await landsOn("/overview");
  });

  it("shows a member the new rail", async () => {
    mockFetch(signedInAs("member", { flags: V2 }));
    renderAt("/overview");
    expect(await railLabels()).toEqual([
      "Overview",
      "Agents",
      "Rooms",
      "Templates",
      "Resources",
      "Ecosystem",
      "Settings",
    ]);
  });

  it("puts Connectors on the rail where connectors run, and Platform for the operator", async () => {
    mockFetch(signedInAs("operator", { flags: [...V2, "service_connections"] }));
    renderAt("/overview");
    const labels = await railLabels();
    expect(labels).toContain("Connectors");
    expect(labels.at(-1)).toBe("Platform");
  });

  it("moves today's pages, keeping the query and fragment", async () => {
    const moves: [string, string][] = [
      ["/collaborations?bridge=b1#teams", "/settings/messaging-apps?bridge=b1#teams"],
      ["/registration-keys", "/settings/api-keys"],
      ["/workspace", "/settings/users"],
      ["/resources/templates/tpl-1", "/templates/tpl-1"],
      ["/resources?tab=templates", "/templates"],
    ];
    for (const [from, to] of moves) {
      mockFetch(signedInAs("workspace_admin", { flags: V2 }));
      renderAt(from);
      await landsOn(to);
      cleanup();
    }
  });

  it("moves the operator's pages to Platform", async () => {
    for (const [from, to] of [
      ["/operator/workspaces", "/platform/workspaces"],
      ["/users", "/platform/users"],
    ]) {
      mockFetch(signedInAs("operator", { flags: V2 }));
      renderAt(from);
      await landsOn(to);
      cleanup();
    }
  });

  it("keeps Templates out of Resources", async () => {
    mockFetch(signedInAs("member", { flags: V2 }));
    renderAt("/resources");
    expect(await screen.findByRole("tab", { name: "References" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Templates" })).toBeNull();
  });

  describe("workspace settings", () => {
    it("shows a member the pages they may open, with nothing an admin's", async () => {
      mockFetch(signedInAs("member", { flags: V2 }));
      renderAt("/settings/general");
      expect(await menuLabels("Workspace settings")).toEqual([
        "General",
        "Users",
        "Messaging apps",
        "API keys",
        "Guardrails",
        "Your account",
      ]);
    });

    it("gives a workspace admin Usage & budget, and Devices and Connectors where they run", async () => {
      mockFetch(
        signedInAs("workspace_admin", {
          flags: [...V2, "agent_management", "service_connections"],
        }),
      );
      renderAt("/settings/general");
      expect(await menuLabels("Workspace settings")).toEqual([
        "General",
        "Users",
        "Messaging apps",
        "Connectors",
        "API keys",
        "Guardrails",
        "Devices",
        "Usage & budget",
        "Your account",
      ]);
    });

    it("leads an organization admin on to Organization settings", async () => {
      mockFetch(signedInAs("org_admin", { flags: V2 }));
      renderAt("/settings/general");
      expect(await menuLabels("Workspace settings")).toContain("Organization settings ›");
    });

    it("keeps Usage & budget at its own URL, inside the area", async () => {
      mockFetch(signedInAs("workspace_admin", { flags: V2 }));
      renderAt("/usage");
      expect(await menuLabels("Workspace settings")).toContain("Usage & budget");
    });

    it("refuses a settings page named in the URL, and says why", async () => {
      mockFetch(signedInAs("member", { flags: V2 }));
      renderAt("/usage");
      expect(await screen.findByText("Only this workspace's admins can open this page.")).toBeTruthy();
    });

    it("opens on the page last used there", async () => {
      window.localStorage.setItem("switch.settings.lastPage.workspace", "/settings/api-keys");
      mockFetch(signedInAs("member", { flags: V2 }));
      renderAt("/settings");
      await landsOn("/settings/api-keys");
    });

    it("opens on General when the page last used there may no longer be opened", async () => {
      window.localStorage.setItem("switch.settings.lastPage.workspace", "/usage");
      mockFetch(signedInAs("member", { flags: V2 }));
      renderAt("/settings");
      await landsOn("/settings/general");
    });

    it("remembers the page someone opens", async () => {
      mockFetch(signedInAs("member", { flags: V2 }));
      renderAt("/settings/users");
      await screen.findByRole("navigation", { name: "Workspace settings" });
      await waitFor(() =>
        expect(window.localStorage.getItem("switch.settings.lastPage.workspace")).toBe(
          "/settings/users",
        ),
      );
    });

    it("carries a settings page across a workspace switch", async () => {
      window.sessionStorage.setItem("switch.settings.afterSwitch", "/settings/api-keys");
      mockFetch(signedInAs("member", { flags: V2 }));
      renderAt("/settings");
      await landsOn("/settings/api-keys");
      expect(window.sessionStorage.getItem("switch.settings.afterSwitch")).toBeNull();
    });

    it("lands on General after a switch to a workspace where the page may not be opened", async () => {
      window.sessionStorage.setItem("switch.settings.afterSwitch", "/settings/org/users");
      mockFetch(signedInAs("member", { flags: V2 }));
      renderAt("/settings");
      await landsOn("/settings/general");
    });
  });

  describe("organization settings", () => {
    it("lets an organization admin in, on General", async () => {
      mockFetch(signedInAs("org_admin", { flags: V2 }));
      renderAt("/organization");
      await landsOn("/settings/org/general");
      expect(await menuLabels("Organization settings")).toEqual([
        "General",
        "Workspaces",
        "Users",
        "Guardrails",
        "Devices",
        "Audit log",
        "‹ Workspace settings",
      ]);
    });

    it("lists Connectors and apps where the server lets organizations have them", async () => {
      mockFetch(
        signedInAs("org_admin", {
          flags: [...V2, "service_connections", "organization_connector_apps"],
        }),
      );
      renderAt("/settings/org/general");
      expect(await menuLabels("Organization settings")).toContain("Connectors and apps");
    });

    it("lets the operator in, to restore an organization's admin", async () => {
      mockFetch(signedInAs("operator", { flags: V2 }));
      renderAt("/settings/org/users");
      expect(await menuLabels("Organization settings")).toContain("Users");
    });

    it("keeps workspace admins and members out, showing no menu", async () => {
      for (const role of ["workspace_admin", "member"] as const) {
        mockFetch(signedInAs(role, { flags: V2 }));
        renderAt("/settings/org/users");
        expect(
          await screen.findByText("Only the organization's admins can open this page."),
        ).toBeTruthy();
        expect(screen.queryByRole("navigation", { name: "Organization settings" })).toBeNull();
        cleanup();
      }
    });

    it("is not offered to a workspace admin", async () => {
      mockFetch(signedInAs("workspace_admin", { flags: V2 }));
      renderAt("/settings/general");
      expect(await menuLabels("Workspace settings")).not.toContain("Organization settings ›");
    });
  });

  describe("platform", () => {
    it("gives the operator their pages", async () => {
      mockFetch(signedInAs("operator", { flags: V2 }));
      renderAt("/platform");
      await landsOn("/platform/workspaces");
      expect(await menuLabels("Platform")).toEqual(["All workspaces", "Users", "Connectors"]);
    });

    it("keeps everyone else out", async () => {
      mockFetch(signedInAs("org_admin", { flags: V2 }));
      renderAt("/platform/users");
      expect(await screen.findByText("Only the platform operator can open this page.")).toBeTruthy();
    });
  });

  it("shows a page that is not built yet as such", async () => {
    mockFetch(signedInAs("member", { flags: V2 }));
    renderAt("/settings/guardrails");
    expect(
      await screen.findByText("This page is part of the new layout and isn't built yet."),
    ).toBeTruthy();
  });
});

describe("a page that falls behind the server", () => {
  const originalLocation = window.location;
  const reload = vi.fn();

  beforeEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...originalLocation, reload },
    });
  });

  afterEach(() => {
    reload.mockClear();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
    Reflect.deleteProperty(document, "visibilityState");
  });

  async function restoreAfter(serverSession: Session) {
    mockFetch(signedInAs("org_admin", { tenants: [beta] }));
    renderAt("/workspace");
    expect(await screen.findByRole("heading", { name: "Acme" })).toBeTruthy();
    mockFetch({ ...signedInAs("org_admin"), "/auth/session": [200, serverSession] });
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
  }

  it("reloads when the session has moved to another workspace", async () => {
    await restoreAfter(session({ state: "ready", tenant: beta, tenants: [acme, beta] }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("stays as it is in the same workspace", async () => {
    await restoreAfter(session({ state: "ready", tenant: acme, tenants: [acme, beta] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reload).not.toHaveBeenCalled();
  });

  it("follows a change of role when the tab comes back", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/rooms");
    expect(await railLabels()).not.toContain("Usage");

    mockFetch(signedInAs("workspace_admin"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(async () => expect(await railLabels()).toContain("Usage"));
    expect(reload).not.toHaveBeenCalled();
  });
});
