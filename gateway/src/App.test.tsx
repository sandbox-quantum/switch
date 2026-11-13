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
  archived_at: null,
};
const beta: TenantMembership = {
  id: "t2",
  slug: "beta",
  name: "Beta Co",
  role: "member",
  organization_role: "member",
  organization_id: "o2",
  archived_at: null,
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
    archived_at: null,
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
    "/organizations": [
      200,
      [
        { id: "o1", slug: "acme-group", name: "Acme Group", role: tenant.organization_role },
        { id: "o2", slug: "beta-holdings", name: "Beta Holdings", role: "member" },
      ],
    ],
    "/tenants/counts": [
      200,
      [
        { id: "t1", users: 3, agents: 2 },
        { id: "t2", users: 1, agents: 0 },
      ],
    ],
    "/tenants/current": [
      200,
      {
        id: "t1",
        slug: "acme",
        name: "Acme",
        role: tenant.role,
        administers: role !== "member",
        can_delete: canDelete,
        can_manage_data_protection: canDelete,
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
      "API keys",
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
    expect(labels).toContain("Devices");
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
    expect(screen.getByText("Agent management isn't turned on here.")).toBeTruthy();
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

  it("keeps switching workspace in the account menu, and claims nothing about the system's health", async () => {
    mockFetch(signedInAs("member", { tenants: [beta] }));
    renderAt("/rooms");
    fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    expect(await screen.findByText("Switch to Beta Co")).toBeTruthy();
    expect(screen.queryByText("System healthy")).toBeNull();
    expect(screen.queryByRole("link", { name: "Help" })).toBeNull();
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
      ["/resources?tab=templates&q=ci#top", "/templates?q=ci#top"],
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

    it("carries an organization settings page across to an organization admin", async () => {
      window.sessionStorage.setItem("switch.settings.afterSwitch", "/settings/org/users");
      mockFetch(signedInAs("org_admin", { flags: V2 }));
      renderAt("/settings");
      await landsOn("/settings/org/users");
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

    it("lets the operator in, to restore an organization's admin, and no further", async () => {
      mockFetch(signedInAs("operator", { flags: V2 }));
      renderAt("/settings/org/users");
      expect(await menuLabels("Organization settings")).toEqual([
        "General",
        "Workspaces",
        "Users",
        "‹ Workspace settings",
      ]);
      cleanup();

      mockFetch(signedInAs("operator", { flags: V2 }));
      renderAt("/settings/org/audit-log");
      expect(await screen.findByText("Only the organization's admins can open this page.")).toBeTruthy();
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

  describe("the top bar", () => {
    async function openSwitcher() {
      fireEvent.click(await screen.findByRole("button", { name: /Acme Group\s*\/\s*Acme/ }));
      return screen.findByRole("menu", { name: "Workspaces" });
    }

    it("names the organization, the workspace and the page", async () => {
      mockFetch(signedInAs("member", { flags: V2 }));
      renderAt("/rooms");
      expect(await screen.findByRole("button", { name: /Acme Group\s*\/\s*Acme/ })).toBeTruthy();
      expect(screen.getByText("Rooms", { selector: "span" })).toBeTruthy();
    });

    it("names only the workspace where it belongs to no organization", async () => {
      mockFetch(signedInAs("member", { flags: V2, inOrganization: false }));
      renderAt("/rooms");
      const crumb = await screen.findByRole("button", { name: "Acme" });
      expect(crumb.getAttribute("aria-haspopup")).toBe("menu");
    });

    it("lists the workspaces by organization, with their users and agents", async () => {
      mockFetch(signedInAs("member", { flags: V2, tenants: [beta] }));
      renderAt("/rooms");
      const menu = await openSwitcher();
      expect(within(menu).getByText("Acme Group")).toBeTruthy();
      expect(within(menu).getByText("Beta Holdings")).toBeTruthy();
      expect(await within(menu).findByText("3 users · 2 agents")).toBeTruthy();
      expect(within(menu).getByText("1 user · 0 agents")).toBeTruthy();
      const current = within(menu).getByRole("menuitem", { current: true });
      expect(current.textContent).toContain("Acme");
    });

    it("names the organization of a workspace the operator entered on the operator flag alone", async () => {
      const entered: TenantMembership = {
        id: "t9",
        slug: "gamma",
        name: "Gamma",
        role: "admin",
        organization_role: null,
        organization_id: "o9",
        archived_at: null,
      };
      const operator = signedInAs("operator", { flags: V2, tenants: [beta] });
      mockFetch({
        ...operator,
        "/auth/session": [
          200,
          session({
            state: "ready",
            tenant: entered,
            tenants: [acme, beta],
            user: { id: "u1", name: "Ada", email: "ada@example.com", is_operator: true },
          }),
        ],
        "/tenants/current": [
          200,
          { ...entered, administers: true, can_delete: false, can_manage_data_protection: false },
        ],
        "/organizations/current": [
          200,
          {
            id: "o9",
            slug: "gamma-corp",
            name: "Gamma Corp",
            role: null,
            members_from_directory: false,
            directory_takes_changes: false,
            administers: false,
            can_manage_members: false,
          },
        ],
      });
      renderAt("/rooms");
      fireEvent.click(await screen.findByRole("button", { name: /Gamma Corp\s*\/\s*Gamma/ }));
      const menu = await screen.findByRole("menu", { name: "Workspaces" });
      for (const heading of ["Acme Group", "Beta Holdings", "Gamma Corp"]) {
        expect(within(menu).getByText(heading)).toBeTruthy();
      }
      expect(within(menu).getByRole("menuitem", { current: true }).textContent).toContain("Gamma");
    });

    it("says so when the counts cannot be read, and still lists the workspaces", async () => {
      mockFetch({
        ...signedInAs("member", { flags: V2, tenants: [beta] }),
        "/tenants/counts": [500, { detail: "counts unavailable" }],
      });
      renderAt("/rooms");
      const menu = await openSwitcher();
      expect(
        await within(menu).findByText(/Could not load how many users and agents.*counts unavailable/),
      ).toBeTruthy();
      expect(within(menu).getByText("Beta Co")).toBeTruthy();
    });

    it("switches to the workspace chosen", async () => {
      const assign = vi.fn();
      const originalLocation = window.location;
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: { ...originalLocation, assign, pathname: "/rooms" },
      });
      try {
        mockFetch({
          ...signedInAs("member", { flags: V2, tenants: [beta] }),
          "/tenants/t2/switch": [200, { ok: true }],
        });
        renderAt("/rooms");
        const menu = await openSwitcher();
        fireEvent.click(within(menu).getByText("Beta Co"));
        await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
        expect(
          vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith("/tenants/t2/switch")),
        ).toBe(true);
      } finally {
        Object.defineProperty(window, "location", {
          configurable: true,
          writable: true,
          value: originalLocation,
        });
      }
    });

    it("lets a workspace admin or an organization admin invite people", async () => {
      for (const role of ["workspace_admin", "org_admin"] as const) {
        mockFetch(signedInAs(role, { flags: V2 }));
        renderAt("/rooms");
        const menu = await openSwitcher();
        fireEvent.click(within(menu).getByRole("menuitem", { name: "Invite people to Acme" }));
        expect(await screen.findByRole("dialog", { name: "Invite users to Acme" })).toBeTruthy();
        cleanup();
      }
    });

    it("does not offer a member to invite people", async () => {
      mockFetch(signedInAs("member", { flags: V2 }));
      renderAt("/rooms");
      const menu = await openSwitcher();
      expect(within(menu).queryByRole("menuitem", { name: /Invite people/ })).toBeNull();
    });

    it("links to help and the docs, and claims nothing about the system's health", async () => {
      mockFetch(signedInAs("member", { flags: V2 }));
      renderAt("/rooms");
      const help = await screen.findByRole("link", { name: "Help" });
      expect(help.getAttribute("href")).toBe(
        "https://docs.switchagents.ai/switch-rooms/resources/troubleshooting",
      );
      expect(screen.getByRole("link", { name: "Docs" })).toBeTruthy();
      expect(screen.queryByText("System healthy")).toBeNull();
    });
  });

  describe("the account menu", () => {
    it("leads to your account, and leaves switching workspace to the top bar", async () => {
      mockFetch(signedInAs("member", { flags: V2, tenants: [beta] }));
      renderAt("/rooms");
      fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
      const account = await screen.findByRole("menuitem", { name: "Your account" });
      expect(account.getAttribute("href")).toBe("/settings/account");
      expect(screen.queryByText("Switch to Beta Co")).toBeNull();
      expect(screen.getByRole("menuitem", { name: "Change password" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Create organization" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
    });
  });

  describe("in organization settings", () => {
    it("hides the rail and leads back to the workspace", async () => {
      mockFetch(signedInAs("org_admin", { flags: V2 }));
      renderAt("/settings/org/general");
      const back = await screen.findByRole("link", { name: "Back to workspace" });
      expect(back.getAttribute("href")).toBe("/");
      expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Acme Group/ })).toBeNull();
    });

    it("keeps the rail everywhere else in settings", async () => {
      mockFetch(signedInAs("org_admin", { flags: V2 }));
      renderAt("/settings/general");
      expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
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

describe("renaming the workspace (gateway_v2)", () => {
  const V2: FeatureFlagKey[] = ["gateway_v2"];

  afterEach(() => Reflect.deleteProperty(document, "visibilityState"));

  /** The server as `signedInAs` answers it, holding Acme's name, which a
   * `PATCH /tenants/t1` changes. Each session read can be held until the
   * test lets it answer, with the name as it stood when it was asked. */
  function serverHolding(routes: Routes) {
    let name = "Acme";
    const held: (() => void)[] = [];
    const state = { holdSessionReads: false, renames: [] as string[] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace(/^\/gateway/, "").split("?")[0];
        const method = init?.method ?? "GET";
        if (method === "PATCH" && path === "/tenants/t1") {
          name = JSON.parse(String(init?.body)).name;
          state.renames.push(name);
          return new Response(JSON.stringify({ id: "t1", name }), { status: 200 });
        }
        const [status, body] = routes[path] ?? [404, { detail: `unmocked ${path}` }];
        let answered = body;
        if (path === "/auth/session") {
          const current = body as Session;
          const named = (t: TenantMembership) => (t.id === "t1" ? { ...t, name } : t);
          answered = {
            ...current,
            tenant: current.tenant && named(current.tenant),
            tenants: current.tenants.map(named),
          };
          if (state.holdSessionReads) await new Promise<void>((resolve) => held.push(resolve));
        }
        if (path === "/tenants/current") answered = { ...(body as object), name };
        return new Response(JSON.stringify(answered), { status });
      }),
    );
    const release = () => held.splice(0).forEach((answer) => answer());
    return { state, release };
  }

  const retention: Routes = {
    "/tenants/t1/retention": [
      200,
      { message_retention_days: null, updated_at: null, updated_by_user_id: null },
    ],
  };

  const breadcrumb = () => screen.getByRole("button", { name: /Acme Group/ });

  it("shows a member the name with no way to change it, and says who can", async () => {
    serverHolding(signedInAs("member", { flags: V2 }));
    renderAt("/settings/general");
    expect(await screen.findByRole("heading", { name: "General" })).toBeTruthy();
    expect((screen.getByLabelText("Workspace name") as HTMLInputElement).value).toBe("Acme");
    expect(screen.getByText("An org admin or a workspace admin can change this.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rename workspace" })).toBeNull();
  });

  it("puts the new name in the breadcrumb and the switcher as soon as it is updated", async () => {
    const { state } = serverHolding({
      ...signedInAs("workspace_admin", { flags: V2, tenants: [beta] }),
      ...retention,
    });
    renderAt("/settings/general");
    fireEvent.click(await screen.findByRole("button", { name: "Rename workspace" }));
    fireEvent.change(screen.getByLabelText("Workspace name"), {
      target: { value: "  Research  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    expect(await screen.findByText("Workspace renamed to Research.")).toBeTruthy();
    // Closing it keeps the name while it fades.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByText("Workspace renamed to .")).toBeNull();
    await waitFor(() => expect(screen.queryByText("Workspace renamed to Research.")).toBeNull());
    expect(state.renames).toEqual(["Research"]);
    expect((screen.getByLabelText("Workspace name") as HTMLInputElement).value).toBe("Research");
    expect(breadcrumb().textContent).toContain("Research");

    fireEvent.click(breadcrumb());
    const switcher = await screen.findByRole("menu", { name: "Workspaces" });
    expect(within(switcher).getByText("Research")).toBeTruthy();
    expect(within(switcher).queryByText("Acme")).toBeNull();
  });

  it("reads the session again after a read already under way, which still has the old name", async () => {
    const { state, release } = serverHolding({
      ...signedInAs("org_admin", { flags: V2 }),
      ...retention,
    });
    renderAt("/settings/general");
    fireEvent.click(await screen.findByRole("button", { name: "Rename workspace" }));

    // Coming back to the tab starts a read, held while the rename is made.
    state.holdSessionReads = true;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/auth/session")),
      ).toHaveLength(2),
    );

    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "Research" } });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(state.renames).toEqual(["Research"]));
    state.holdSessionReads = false;
    release();

    expect(await screen.findByText("Workspace renamed to Research.")).toBeTruthy();
    expect(breadcrumb().textContent).toContain("Research");
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

  function comeBackToTheTab() {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  it("reads the session once when a restore and a tab coming back arrive together", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/rooms");
    await railLabels();
    mockFetch(signedInAs("member"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    comeBackToTheTab();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessionReads = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input).endsWith("/auth/session"));
    expect(sessionReads).toHaveLength(1);
  });

  it("warns, keeping the page, when the session cannot be read on coming back to the tab", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/rooms");
    await railLabels();
    mockFetch({ ...signedInAs("member"), "/auth/session": [503, { detail: "server restarting" }] });
    comeBackToTheTab();
    expect(
      await screen.findByText(/Could not check your session with Switch: server restarting/),
    ).toBeTruthy();
    expect(await railLabels()).toContain("Rooms");

    mockFetch(signedInAs("member"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByText(/Could not check your session with Switch/)).toBeNull(),
    );
  });

  it("fails loud when a restored page cannot be checked, since it may be another workspace's", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/rooms");
    await railLabels();
    mockFetch({ ...signedInAs("member"), "/auth/session": [503, { detail: "server restarting" }] });
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(
      await screen.findByText(/Could not load your session: server restarting/),
    ).toBeTruthy();
  });

  it("follows a change of role when the tab comes back", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/rooms");
    expect(await railLabels()).not.toContain("Usage");

    mockFetch(signedInAs("workspace_admin"));
    comeBackToTheTab();

    await waitFor(async () => expect(await railLabels()).toContain("Usage"));
    expect(reload).not.toHaveBeenCalled();
  });
});
