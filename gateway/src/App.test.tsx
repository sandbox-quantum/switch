import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "./App";
import type { Session, TenantMembership } from "./data/api";
import { AuthProvider } from "./data/AuthContext";
import { gatewayFetch } from "./data/gatewayFetch";
import type { FeatureFlagKey } from "./data/featureFlags";
import { clearPendingInvite, storePendingInvite } from "./data/sessionState";
import { OPERATOR_ELSEWHERE, keepLinkForSignIn } from "./data/workspaceLink";

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
    can_manage_connector_apps: false,
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
    canManageConnectorApps = role === "operator",
  }: {
    flags?: FeatureFlagKey[];
    inOrganization?: boolean;
    tenants?: TenantMembership[];
    canDelete?: boolean;
    // The operator may set up the deployment's connector apps, and the admins
    // of its only organization while it has no other.
    canManageConnectorApps?: boolean;
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
        can_manage_connector_apps: canManageConnectorApps,
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

/** The rail's links by their names: the label under each glyph, or, for
 * one shown as a glyph alone, its accessible name. */
async function railLabels(): Promise<string[]> {
  const rail = await screen.findByRole("navigation", { name: "Main" });
  return within(rail)
    .getAllByRole("link")
    .map((link) => link.getAttribute("aria-label") ?? link.textContent ?? "");
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

  it("stays signed in, saying so, when signing out fails", async () => {
    // An invitation to follow, so the screen is the one before a workspace.
    storePendingInvite("abc");
    mockFetch({
      ...signedInAs("org_admin"),
      "/auth/logout": [502, { detail: "Bad Gateway" }],
    });
    renderAt("/");
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Couldn't sign out: Bad Gateway")).toBeTruthy();
    expect(screen.queryByText("Switch Gateway")).toBeNull();
    // Still signed in, so still on the way to the invitation.
    expect(window.sessionStorage.getItem("switch.pendingInvite")).toBe("abc");
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

  it("says a page is not turned on, and tells the operator how", async () => {
    mockFetch(signedInAs("operator"));
    renderAt("/settings/devices");
    expect(await screen.findByText("Not turned on")).toBeTruthy();
    expect(screen.getByText("Agent management isn't turned on here.")).toBeTruthy();
    expect(
      screen.getByText("An operator turns it on by adding agent_management to FEATURE_FLAGS_ENABLED."),
    ).toBeTruthy();
  });

  it("does not tell anyone but the operator how to turn a page on", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/settings/devices");
    expect(await screen.findByText("Not turned on")).toBeTruthy();
    expect(screen.queryByText(/FEATURE_FLAGS_ENABLED/)).toBeNull();
  });

  it("stays signed in, saying so, when signing out of every device from the menu fails", async () => {
    mockFetch({
      ...signedInAs("member"),
      "/auth/sessions/revoke": [500, { detail: "Internal Server Error" }],
    });
    renderAt("/rooms");
    fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out of all devices" }));
    expect(
      await screen.findByText("Couldn't sign out of every device: Internal Server Error"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Account menu" })).toBeTruthy();
  });
});

describe("deleting the workspace", () => {
  it("is offered where the server says the caller may delete it", async () => {
    mockFetch(signedInAs("workspace_admin", { canDelete: true }));
    renderAt("/settings/general");
    expect(await screen.findByRole("button", { name: "Delete workspace" })).toBeTruthy();
  });

  it("is not offered to an admin the server will not let delete it, such as an org admin", async () => {
    mockFetch(signedInAs("org_admin", { canDelete: false }));
    renderAt("/settings/general");
    expect(await screen.findByRole("heading", { name: "General" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete workspace" })).toBeNull();
  });
});

describe("the layout", () => {

  it("opens on Home", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/");
    await landsOn("/overview");
  });

  it("shows a member the new rail", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/overview");
    expect(await railLabels()).toEqual([
      "Home",
      "Agents",
      "Rooms",
      "Templates",
      "Resources",
      "Settings",
    ]);
  });

  it("shows the Settings cog without a label, and every other item with one", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/overview");
    const rail = await screen.findByRole("navigation", { name: "Main" });
    expect(within(rail).getByRole("link", { name: "Settings" }).textContent).toBe("");
    expect(within(rail).getByRole("link", { name: "Home" }).textContent).toBe("Home");
  });

  it("puts Connectors on the rail where connectors run, and nothing more for the operator", async () => {
    mockFetch(signedInAs("operator", { flags: ["service_connections"] }));
    renderAt("/overview");
    const labels = await railLabels();
    expect(labels).toContain("Connectors");
    expect(labels.at(-1)).toBe("Settings");
    expect(labels).not.toContain("Platform");
  });

  it("moves today's pages, keeping the query and fragment", async () => {
    const moves: [string, string][] = [
      ["/collaborations?bridge=b1#teams", "/settings/messaging-apps?bridge=b1#teams"],
      ["/registration-keys", "/settings/api-keys"],
      ["/workspace", "/settings/users"],
      ["/workspace/private-channel-rooms", "/settings/general/private-channel-rooms"],
      ["/resources/templates/tpl-1", "/templates/tpl-1"],
      ["/resources?tab=templates&q=ci#top", "/templates?q=ci#top"],
    ];
    for (const [from, to] of moves) {
      mockFetch(signedInAs("workspace_admin"));
      renderAt(from);
      await landsOn(to);
      cleanup();
    }
  });

  it("opens the review of Public rooms on private channels inside Settings, leading back to General", async () => {
    mockFetch(signedInAs("workspace_admin"));
    renderAt("/settings/general/private-channel-rooms");
    expect(await menuLabels("Settings")).toContain("General");
    const menu = screen.getByRole("navigation", { name: "Settings" });
    expect(within(menu).getByRole("link", { name: "General" }).className).toContain("Mui-selected");
    fireEvent.click(await screen.findByRole("button", { name: "General" }));
    await landsOn("/settings/general");
  });

  it("sends the operator's old pages, and Platform's, to Organization settings", async () => {
    for (const [from, to] of [
      ["/operator/workspaces", "/settings/org/workspaces"],
      ["/users", "/settings/org/users"],
      ["/platform", "/settings/org/workspaces"],
      ["/platform/workspaces", "/settings/org/workspaces"],
      ["/platform/users", "/settings/org/users"],
      ["/platform/connectors", "/settings/org/connector-apps"],
    ]) {
      mockFetch(signedInAs("operator"));
      renderAt(from);
      await landsOn(to);
      cleanup();
    }
  });

  it("marks the rail item a page belongs to as the current one", async () => {
    mockFetch(signedInAs("workspace_admin"));
    renderAt("/usage");
    const rail = await screen.findByRole("navigation", { name: "Main" });
    await waitFor(() =>
      expect(within(rail).getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page"),
    );
    expect(within(rail).getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBeNull();
  });

  it("keeps Templates out of Resources", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/resources");
    expect(await screen.findByRole("tab", { name: "References" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Templates" })).toBeNull();
  });

  describe("workspace settings", () => {
    it("is titled Settings across the area, with its own pages headed This workspace", async () => {
      mockFetch(signedInAs("member"));
      renderAt("/settings/general");
      expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
      const menu = await screen.findByRole("navigation", { name: "Settings" });
      expect(within(menu).getByText("This workspace")).toBeTruthy();
    });

    it("marks the way into Organization settings with a chevron, not text", async () => {
      mockFetch(signedInAs("org_admin"));
      renderAt("/settings/general");
      const menu = await screen.findByRole("navigation", { name: "Settings" });
      const across = within(menu).getByRole("link", { name: "Organization settings" });
      expect(across.getAttribute("href")).toBe("/settings/org");
      expect(across.querySelector("svg")).not.toBeNull();
    });

    it("shows a member the pages they may open, with nothing an admin's", async () => {
      mockFetch(signedInAs("member"));
      renderAt("/settings/general");
      expect(await menuLabels("Settings")).toEqual([
        "General",
        "Users",
        "Messaging apps",
        "API keys",
        "Guardrails",
        "Your account",
        "Organization settings",
      ]);
    });

    it("gives a workspace admin Devices and Connectors where they run", async () => {
      mockFetch(
        signedInAs("workspace_admin", {
          flags: ["agent_management", "service_connections"],
        }),
      );
      renderAt("/settings/general");
      expect(await menuLabels("Settings")).toEqual([
        "General",
        "Users",
        "Messaging apps",
        "Connectors",
        "API keys",
        "Guardrails",
        "Devices",
        "Your account",
        "Organization settings",
      ]);
    });

    it("leads an organization admin on to Organization settings", async () => {
      mockFetch(signedInAs("org_admin"));
      renderAt("/settings/general");
      expect(await menuLabels("Settings")).toContain("Organization settings");
    });

    it("sets Your account, and the way to Organization settings, each in a group of its own", async () => {
      mockFetch(signedInAs("org_admin"));
      renderAt("/settings/general");
      const menu = await screen.findByRole("navigation", { name: "Settings" });
      const groups = within(menu)
        .getAllByRole("list")
        .map((list) => within(list).getAllByRole("link").map((link) => link.textContent));
      expect(groups.slice(1)).toEqual([["Your account"], ["Organization settings"]]);
      expect(groups[0]).not.toContain("Your account");
      expect(within(menu).getAllByRole("separator")).toHaveLength(2);
    });

    it("gives a member's Your account its own group too, and no way to an organization it has none", async () => {
      mockFetch(signedInAs("member", { inOrganization: false }));
      renderAt("/settings/general");
      const menu = await screen.findByRole("navigation", { name: "Settings" });
      const lists = within(menu).getAllByRole("list");
      expect(within(lists[lists.length - 1]).getAllByRole("link").map((l) => l.textContent)).toEqual([
        "Your account",
      ]);
      expect(within(menu).getAllByRole("separator")).toHaveLength(1);
    });

    it("sends Usage & budget, which is off, to the area", async () => {
      mockFetch(signedInAs("workspace_admin"));
      renderAt("/usage");
      await landsOn("/settings/general");
      expect(await menuLabels("Settings")).not.toContain("Usage & budget");
    });

    it("refuses a settings page named in the URL, and says why", async () => {
      mockFetch(signedInAs("member"));
      renderAt("/settings/general/private-channel-rooms");
      expect(await screen.findByText("Only this workspace's admins can open this page.")).toBeTruthy();
    });

    it("opens on the page last used there", async () => {
      window.localStorage.setItem("switch.settings.lastPage.workspace", "/settings/api-keys");
      mockFetch(signedInAs("member"));
      renderAt("/settings");
      await landsOn("/settings/api-keys");
    });

    it("opens on General when the page last used there may no longer be opened", async () => {
      window.localStorage.setItem("switch.settings.lastPage.workspace", "/usage");
      mockFetch(signedInAs("member"));
      renderAt("/settings");
      await landsOn("/settings/general");
    });

    it("remembers the page someone opens", async () => {
      mockFetch(signedInAs("member"));
      renderAt("/settings/users");
      await screen.findByRole("navigation", { name: "Settings" });
      await waitFor(() =>
        expect(window.localStorage.getItem("switch.settings.lastPage.workspace")).toBe(
          "/settings/users",
        ),
      );
    });

    it("carries a settings page across a workspace switch", async () => {
      window.sessionStorage.setItem("switch.settings.afterSwitch", "/settings/api-keys");
      mockFetch(signedInAs("member"));
      renderAt("/settings");
      await landsOn("/settings/api-keys");
      expect(window.sessionStorage.getItem("switch.settings.afterSwitch")).toBeNull();
    });

    it("carries an organization settings page across to an organization admin", async () => {
      window.sessionStorage.setItem("switch.settings.afterSwitch", "/settings/org/users");
      mockFetch(signedInAs("org_admin"));
      renderAt("/settings");
      await landsOn("/settings/org/users");
    });

    it("lands on General after a switch to a workspace where the page may not be opened", async () => {
      window.sessionStorage.setItem("switch.settings.afterSwitch", "/settings/org/general");
      mockFetch(signedInAs("member"));
      renderAt("/settings");
      await landsOn("/settings/general");
    });
  });

  describe("organization settings", () => {
    it("is titled Organization settings, with no heading over its menu", async () => {
      mockFetch(signedInAs("org_admin"));
      renderAt("/settings/org/general");
      expect(
        await screen.findByRole("heading", { level: 1, name: "Organization settings" }),
      ).toBeTruthy();
      const menu = await screen.findByRole("navigation", { name: "Organization settings" });
      expect(within(menu).queryByText("This workspace")).toBeNull();
      expect(within(menu).queryByText("Organization settings")).toBeNull();
    });

    it("lets an organization admin in, on General", async () => {
      mockFetch(signedInAs("org_admin"));
      renderAt("/organization");
      await landsOn("/settings/org/general");
      expect(await menuLabels("Organization settings")).toEqual([
        "General",
        "Workspaces",
        "Users",
        "Guardrails",
        "Audit log",
      ]);
    });

    it("lists Devices where the server runs agent management", async () => {
      mockFetch(signedInAs("org_admin", { flags: ["agent_management"] }));
      renderAt("/settings/org/general");
      expect(await menuLabels("Organization settings")).toContain("Devices");
    });

    it("lists Connectors where the server lets organizations have them", async () => {
      mockFetch(
        signedInAs("org_admin", {
          flags: ["service_connections", "organization_connector_apps"],
        }),
      );
      renderAt("/settings/org/general");
      expect(await menuLabels("Organization settings")).toContain("Connectors");
    });

    it("lets the operator in, to restore an organization's admin and set up connector apps, and no further", async () => {
      mockFetch(signedInAs("operator"));
      renderAt("/settings/org/users");
      expect(await menuLabels("Organization settings")).toEqual([
        "General",
        "Workspaces",
        "Users",
        "Connector apps",
      ]);
      cleanup();

      mockFetch(signedInAs("operator"));
      renderAt("/settings/org/audit-log");
      expect(await screen.findByText("Only the organization's admins can open this page.")).toBeTruthy();
    });

    it("shows workspace admins and members its Users, and nothing more", async () => {
      for (const role of ["workspace_admin", "member"] as const) {
        mockFetch(signedInAs(role));
        renderAt("/settings/org");
        await landsOn("/settings/org/users");
        expect(await menuLabels("Organization settings")).toEqual(["Users"]);
        cleanup();
        mockFetch(signedInAs(role));
        renderAt("/settings/org/general");
        expect(
          await screen.findByText("Only the organization's admins can open this page."),
        ).toBeTruthy();
        cleanup();
      }
    });

    it("is offered to a workspace admin", async () => {
      mockFetch(signedInAs("workspace_admin"));
      renderAt("/settings/general");
      expect(await menuLabels("Settings")).toContain("Organization settings");
    });
  });

  describe("connector apps", () => {
    it("lists Connector apps, after Connectors, for an admin who may set them up", async () => {
      mockFetch({
        ...signedInAs("org_admin", {
          flags: ["service_connections", "organization_connector_apps"],
          canManageConnectorApps: true,
        }),
        "/connector-apps": [200, { public_url: "https://switch.example.test", apps: [] }],
      });
      renderAt("/settings/org/connector-apps");
      const labels = await menuLabels("Organization settings");
      expect(labels.indexOf("Connector apps")).toBe(labels.indexOf("Connectors") + 1);
      expect(await screen.findByRole("heading", { name: "Connector apps" })).toBeTruthy();
    });

    it("opens from a workspace in no organization for whoever may set them up", async () => {
      const routes = {
        ...signedInAs("operator", { inOrganization: false }),
        "/connector-apps": [200, { public_url: "https://switch.example.test", apps: [] }],
      } satisfies Routes;
      mockFetch(routes);
      renderAt("/settings/general");
      expect(await menuLabels("Settings")).toContain("Organization settings");
      cleanup();

      mockFetch(routes);
      renderAt("/settings/org");
      await landsOn("/settings/org/connector-apps");
      expect(await menuLabels("Organization settings")).toEqual(["Connector apps"]);
      expect(await screen.findByRole("heading", { name: "Connector apps" })).toBeTruthy();
      cleanup();

      mockFetch(routes);
      renderAt("/settings/org/general");
      expect(await screen.findByText("This workspace belongs to no organization.")).toBeTruthy();
    });

    it("keeps Organization settings shut, outside an organization, to anyone who may not", async () => {
      mockFetch(signedInAs("member", { inOrganization: false }));
      renderAt("/settings/org/connector-apps");
      expect(await screen.findByText("This workspace belongs to no organization.")).toBeTruthy();
      expect(screen.queryByRole("navigation", { name: "Organization settings" })).toBeNull();
    });

    it("neither lists nor opens it for an admin who may not", async () => {
      mockFetch(signedInAs("org_admin", { flags: ["service_connections"] }));
      renderAt("/settings/org/connector-apps");
      expect(
        await screen.findByText(
          "Only whoever runs Switch, or an admin of its only organization, can open this page.",
        ),
      ).toBeTruthy();
      cleanup();

      mockFetch(signedInAs("org_admin", { flags: ["service_connections"] }));
      renderAt("/settings/org/general");
      expect(await menuLabels("Organization settings")).not.toContain("Connector apps");
    });
  });

  describe("the top bar", () => {
    async function openSwitcher() {
      fireEvent.click(await screen.findByRole("button", { name: /Acme Group\s*\/\s*Acme/ }));
      return screen.findByRole("menu", { name: "Workspaces" });
    }

    it("names the organization, the workspace and the page", async () => {
      mockFetch(signedInAs("member"));
      renderAt("/rooms");
      expect(await screen.findByRole("button", { name: /Acme Group\s*\/\s*Acme/ })).toBeTruthy();
      expect(screen.getByText("Rooms", { selector: "span" })).toBeTruthy();
    });

    it("names only the workspace where it belongs to no organization", async () => {
      mockFetch(signedInAs("member", { inOrganization: false }));
      renderAt("/rooms");
      const crumb = await screen.findByRole("button", { name: "Acme" });
      expect(crumb.getAttribute("aria-haspopup")).toBe("menu");
    });

    it("lists the workspaces by organization, with their users and agents", async () => {
      mockFetch(signedInAs("member", { tenants: [beta] }));
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
      const operator = signedInAs("operator", { tenants: [beta] });
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
        ...signedInAs("member", { tenants: [beta] }),
        "/tenants/counts": [500, { detail: "counts unavailable" }],
      });
      renderAt("/rooms");
      const menu = await openSwitcher();
      expect(
        await within(menu).findByText(/Could not load how many users and agents.*counts unavailable/),
      ).toBeTruthy();
      expect(within(menu).getByText("Beta Co")).toBeTruthy();
    });

    it.each([
      ["a list, staying on it", "/rooms", "/rooms"],
      ["one room, going to the landing page", "/rooms/r1", "/"],
    ])("switches to the workspace chosen from %s", async (_, from, to) => {
      const assign = vi.fn();
      const originalLocation = window.location;
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: { ...originalLocation, assign, pathname: from },
      });
      try {
        mockFetch({
          ...signedInAs("member", { tenants: [beta] }),
          "/tenants/t2/switch": [200, { ok: true }],
        });
        renderAt("/rooms");
        const menu = await openSwitcher();
        fireEvent.click(within(menu).getByText("Beta Co"));
        await waitFor(() => expect(assign).toHaveBeenCalledWith(to));
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
        mockFetch(signedInAs(role));
        renderAt("/rooms");
        const menu = await openSwitcher();
        fireEvent.click(within(menu).getByRole("menuitem", { name: "Invite people to Acme" }));
        expect(await screen.findByRole("dialog", { name: "Invite users to Acme" })).toBeTruthy();
        cleanup();
      }
    });

    it("does not offer a member to invite people", async () => {
      mockFetch(signedInAs("member"));
      renderAt("/rooms");
      const menu = await openSwitcher();
      expect(within(menu).queryByRole("menuitem", { name: /Invite people/ })).toBeNull();
    });

    it("links to help and the docs, and claims nothing about the system's health", async () => {
      mockFetch(signedInAs("member"));
      renderAt("/rooms");
      const help = await screen.findByRole("link", { name: "Help" });
      expect(help.getAttribute("href")).toBe(
        "https://docs.switchagents.ai/switch-rooms/resources/troubleshooting",
      );
      const docs = screen.getByRole("link", { name: "Documentation" });
      expect(docs.getAttribute("href")).toBe(
        "https://docs.switchagents.ai/switch-rooms/getting-started",
      );
      // Glyphs alone: the names are for assistive technology and the tooltip.
      expect(help.textContent).toBe("");
      expect(docs.textContent).toBe("");
      expect(screen.queryByText("System healthy")).toBeNull();
    });
  });

  describe("the account menu", () => {
    it("leads to your account, where the password changes, and leaves switching workspace to the top bar", async () => {
      mockFetch(signedInAs("member", { tenants: [beta] }));
      renderAt("/rooms");
      fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
      const account = await screen.findByRole("menuitem", { name: "Your account" });
      expect(account.getAttribute("href")).toBe("/settings/account");
      expect(screen.queryByText("Switch to Beta Co")).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Change password" })).toBeNull();
      expect(screen.getByRole("menuitem", { name: "Create organization" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
    });
  });

  describe("in organization settings", () => {
    it("hides the rail and leads back to the workspace settings page that was open", async () => {
      mockFetch(signedInAs("org_admin"));
      renderAt("/settings/org/general");
      const back = await screen.findByRole("link", { name: "Back to workspace" });
      expect(back.getAttribute("href")).toBe("/settings");
      expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Acme Group/ })).toBeNull();
    });

    it("comes back out on the workspace settings page it was entered from", async () => {
      mockFetch(signedInAs("org_admin"));
      renderAt("/settings/api-keys");
      fireEvent.click(await screen.findByRole("link", { name: "Organization settings" }));
      await landsOn("/settings/org/general");
      fireEvent.click(await screen.findByRole("link", { name: "Back to workspace" }));
      await landsOn("/settings/api-keys");
    });

    it("shows someone it refuses, or a page that is not there, in the workspace's own chrome", async () => {
      for (const [role, path, inOrganization] of [
        ["member", "/settings/org", false],
        ["workspace_admin", "/settings/org/users", false],
        ["org_admin", "/settings/org/billing", true],
      ] as const) {
        mockFetch(signedInAs(role, { inOrganization }));
        renderAt(path);
        expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
        expect(
          await screen.findByRole("button", {
            name: inOrganization ? /Acme Group\s*\/\s*Acme/ : /Acme/,
          }),
        ).toBeTruthy();
        expect(screen.queryByRole("link", { name: "Back to workspace" })).toBeNull();
        expect(screen.queryByText("Organization settings")).toBeNull();
        cleanup();
      }
    });

    it("leads back to the page it was entered from, however far into it someone went", async () => {
      mockFetch(signedInAs("org_admin"));
      renderAt("/settings/general");
      fireEvent.click(await screen.findByRole("link", { name: "Organization settings" }));
      await landsOn("/settings/org/general");
      const menu = await screen.findByRole("navigation", { name: "Organization settings" });
      fireEvent.click(within(menu).getByRole("link", { name: "Users" }));
      await landsOn("/settings/org/users");

      const back = await screen.findByRole("link", { name: "Back to workspace" });
      expect(back.getAttribute("href")).toBe("/settings/general");
      fireEvent.click(back);
      await landsOn("/settings/general");
      expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
    });

    it("keeps the rail everywhere else in settings", async () => {
      mockFetch(signedInAs("org_admin"));
      renderAt("/settings/general");
      expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
    });
  });

});

describe("renaming the workspace", () => {

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
    serverHolding(signedInAs("member"));
    renderAt("/settings/general");
    expect(await screen.findByRole("heading", { name: "General" })).toBeTruthy();
    expect((screen.getByLabelText("Workspace name") as HTMLInputElement).value).toBe("Acme");
    expect(screen.getByText("An org admin or a workspace admin can change this.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rename workspace" })).toBeNull();
  });

  it("puts the new name in the breadcrumb and the switcher as soon as it is updated", async () => {
    const { state } = serverHolding({
      ...signedInAs("workspace_admin", { tenants: [beta] }),
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
      ...signedInAs("org_admin"),
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
    renderAt("/settings/general");
    expect(await screen.findByRole("heading", { name: "General" })).toBeTruthy();
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
    mockFetch(signedInAs("member", { inOrganization: false }));
    renderAt("/settings/general");
    expect(await menuLabels("Settings")).not.toContain("Organization settings");

    mockFetch(signedInAs("org_admin"));
    comeBackToTheTab();

    await waitFor(async () =>
      expect(await menuLabels("Settings")).toContain("Organization settings"),
    );
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("what the server's answers say about the session", () => {
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
  });

  it("goes to sign-in once the session has ended, keeping the page to come back to", async () => {
    const routes = signedInAs("member");
    let sessionReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input).replace(/^\/gateway/, "").split("?")[0];
        if (path === "/auth/session" && sessionReads++ > 0)
          return new Response(JSON.stringify({ detail: "Session ended" }), { status: 401 });
        if (path === "/rooms")
          return new Response(JSON.stringify({ detail: "Session ended" }), { status: 401 });
        const [status, body] = routes[path] ?? [404, { detail: `unmocked ${path}` }];
        return new Response(JSON.stringify(body), { status });
      }),
    );
    renderAt("/rooms?q=ops");
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(JSON.parse(window.sessionStorage.getItem("switch.workspaceLinkAfterSignIn") ?? "null")).toMatchObject({
      path: "/rooms?q=ops",
      workspace: "t1",
    });
  });

  it("reads the session again when the server refuses something, and follows a change of role", async () => {
    mockFetch(signedInAs("org_admin"));
    renderAt("/settings/general");
    expect(await menuLabels("Settings")).toContain("Organization settings");

    mockFetch({
      ...signedInAs("member", { inOrganization: false }),
      "/tenants/t1/invitations": [403, { detail: "Workspace admin access required" }],
    });
    await gatewayFetch("/gateway/tenants/t1/invitations", { method: "POST" });

    await waitFor(async () =>
      expect(await menuLabels("Settings")).not.toContain("Organization settings"),
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it("names the workspace the page shows on its writes", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/rooms");
    await railLabels();
    mockFetch({ ...signedInAs("member"), "/api-keys": [200, {}] });
    await gatewayFetch("/gateway/api-keys", { method: "POST" });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(new Headers(init?.headers).get("X-Switch-Workspace")).toBe("t1");
  });

  it("says the tab shows another workspace, offering a reload, when a write is refused for it", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/rooms");
    await railLabels();
    mockFetch({
      ...signedInAs("member"),
      "/api-keys": [
        409,
        {
          detail: {
            error: "workspace_mismatch",
            message: "This tab is showing another workspace. Reload to continue.",
          },
        },
      ],
    });
    await gatewayFetch("/gateway/api-keys", { method: "POST" });

    const banner = await screen.findByText("This tab is showing another workspace. Reload to continue.");
    fireEvent.click(within(banner.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalled();
  });
});

describe("a link naming a workspace", () => {
  const originalLocation = window.location;
  const replace = vi.fn();

  beforeEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...originalLocation, replace },
    });
  });

  afterEach(() => {
    replace.mockClear();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  const origin = window.location.origin;
  const sessionReads = () =>
    vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/auth/session"))
      .length;

  const switchedTo = (tenantId: string) =>
    vi
      .mocked(fetch)
      .mock.calls.some(
        ([input, init]) =>
          String(input).endsWith(`/tenants/${tenantId}/switch`) && init?.method === "POST",
      );

  it("switches to it, then opens the same page there", async () => {
    mockFetch({
      ...signedInAs("member", { tenants: [beta] }),
      "/tenants/t2/switch": [200, { ok: true }],
    });
    renderAt("/rooms/r1?workspace=t2");
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`${origin}/rooms/r1`));
    expect(switchedTo("t2")).toBe(true);
    expect(sessionReads()).toBe(1);
  });

  it("switches an organization admin to a workspace their role covers", async () => {
    const covered: TenantMembership = {
      id: "t3",
      slug: "acme-labs",
      name: "Acme Labs",
      role: "admin",
      organization_role: "org_admin",
      organization_id: "o1",
      archived_at: null,
    };
    mockFetch({
      ...signedInAs("org_admin", { tenants: [covered] }),
      "/tenants/t3/switch": [200, { ok: true }],
    });
    renderAt("/settings/org?workspace=t3");
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`${origin}/settings/org`));
    expect(switchedTo("t3")).toBe(true);
  });

  it("picks it for a session that has not picked a workspace yet", async () => {
    mockFetch({
      "/auth/session": [200, session({ state: "needs_selection", tenants: [acme, beta] })],
      "/tenants/t2/switch": [200, { ok: true }],
    });
    renderAt("/settings?workspace=t2");
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`${origin}/settings`));
  });

  it("stays, and drops it from the address, when the page is already there", async () => {
    mockFetch(signedInAs("member", { tenants: [beta] }));
    renderAt("/resources?tab=documents&workspace=t1#top");
    await railLabels();
    await landsOn("/resources?tab=documents#top");
    expect(switchedTo("t1")).toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(sessionReads()).toBe(1);
    expect(screen.queryByText(/The link you followed/)).toBeNull();
  });

  it("does not switch to a workspace the session is not in, and says so", async () => {
    mockFetch(signedInAs("operator"));
    renderAt("/rooms?workspace=t9");
    // The operator is also told where they act on someone else's.
    expect(
      await screen.findByText(
        `The link you followed is for a workspace you aren't in, so this is Acme. ${OPERATOR_ELSEWHERE}`,
      ),
    ).toBeTruthy();
    await landsOn("/rooms");
    expect(switchedTo("t9")).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });

  it("says so on the workspace picker too", async () => {
    mockFetch({
      "/auth/session": [200, session({ state: "needs_selection", tenants: [acme, beta] })],
      "/feature-flags": [200, { flags: [] }],
    });
    renderAt("/?workspace=t9");
    expect(await screen.findByText("Choose a workspace")).toBeTruthy();
    expect(
      screen.getByText("The link you followed is for a workspace you aren't in."),
    ).toBeTruthy();
  });

  it("says so to someone in no workspace yet, and to someone holding an invitation", async () => {
    mockFetch({
      "/auth/session": [200, session({ state: "needs_workspace" })],
      "/feature-flags": [200, { flags: [] }],
    });
    renderAt("/?workspace=t9");
    expect(await screen.findByText("Welcome to Switch")).toBeTruthy();
    expect(
      screen.getByText("The link you followed is for a workspace you aren't in."),
    ).toBeTruthy();
    cleanup();

    storePendingInvite("invite-token");
    renderAt("/?workspace=t9");
    expect(await screen.findByText("Join a workspace")).toBeTruthy();
    expect(
      screen.getByText("The link you followed is for a workspace you aren't in."),
    ).toBeTruthy();
  });

  it("lets the notice be put away", async () => {
    mockFetch(signedInAs("member"));
    renderAt("/rooms?workspace=t9");
    const notice = await screen.findByText(/The link you followed/);
    fireEvent.click(within(notice.closest('[role="alert"]') as HTMLElement).getByRole("button"));
    await waitFor(() => expect(screen.queryByText(/The link you followed/)).toBeNull());
  });

  it("says why when the switch is refused, and opens the page where it was", async () => {
    mockFetch({
      ...signedInAs("member", { tenants: [beta] }),
      "/tenants/t2/switch": [403, { detail: "Not a member of this workspace" }],
    });
    renderAt("/rooms?workspace=t2");
    expect(
      await screen.findByText(
        /Couldn't switch to the workspace the link you followed is for: Not a member of this workspace/,
      ),
    ).toBeTruthy();
    await landsOn("/rooms");
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps the link for a signed-out visitor, and follows it once they sign in", async () => {
    mockFetch({
      "/auth/session": [401, { detail: "Not authenticated" }],
      "/auth/config": [200, authConfig],
      "/auth/login": [200, { id: "u1", name: "Ada", email: "ada@example.com" }],
    });
    renderAt("/rooms/r1?tab=documents&workspace=t2");
    expect(await screen.findByText("Switch Gateway")).toBeTruthy();
    expect(switchedTo("t2")).toBe(false);

    fireEvent.change(await screen.findByLabelText(/^Email/), {
      target: { value: "ada@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(`${origin}/rooms/r1?tab=documents&workspace=t2`),
    );
  });

  it("follows a kept link on the first load signed in, as after a sign-in provider", async () => {
    keepLinkForSignIn({ path: "/agents/a1", workspace: "t2" });
    mockFetch(signedInAs("member", { tenants: [beta] }));
    renderAt("/");
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(`${origin}/agents/a1?workspace=t2`),
    );
    expect(window.sessionStorage.length).toBe(0);
  });

  it("does not hand a kept link to the next person after signing out", async () => {
    mockFetch({
      ...signedInAs("member"),
      "/auth/logout": [200, {}],
    });
    renderAt("/rooms");
    await railLabels();
    keepLinkForSignIn({ path: "/agents/a1", workspace: "t2" });
    fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(window.sessionStorage.length).toBe(0));
  });
});
