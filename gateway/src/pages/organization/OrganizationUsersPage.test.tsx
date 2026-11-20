import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../../data/AuthContext";
import type { CurrentOrganization, OrganizationMemberEntry } from "../../data/api";
import { type Answer, type Call, answerFetch } from "../../test/answerFetch";
import { OrganizationUsersPage } from "./OrganizationPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../components/DataTable", () => import("../../test/FakeDataTable"));

function adminOrg(overrides: Partial<CurrentOrganization> = {}): CurrentOrganization {
  return {
    id: "org-1",
    slug: "acme",
    name: "Acme Inc",
    role: "org_admin",
    members_from_directory: false,
    directory_takes_changes: false,
    administers: true,
    can_manage_members: true,
    ...overrides,
  };
}

function operatorOrg(overrides: Partial<CurrentOrganization> = {}): CurrentOrganization {
  return {
    id: "org-1",
    slug: "acme",
    name: "Acme Inc",
    role: null,
    members_from_directory: false,
    directory_takes_changes: false,
    administers: false,
    can_manage_members: true,
    ...overrides,
  };
}

function member(
  overrides: Partial<OrganizationMemberEntry> & { user_id: string; name: string },
): OrganizationMemberEntry {
  return {
    email: `${overrides.name.toLowerCase()}@example.com`,
    role: "member",
    created_at: "2026-01-01",
    warning: null,
    service_account: false,
    can_change_role: true,
    change_role_blocked_reason: null,
    can_grant_org_admin: true,
    can_remove: true,
    remove_blocked_reason: null,
    workspaces: [],
    ...overrides,
  };
}

// Only `session` and `refresh` are read by this page and what it renders;
// who administers the organization, and what the operator may do, come from
// `CurrentOrganization`, not the session.
function signedIn() {
  const refresh = vi.fn(async () => {});
  vi.mocked(useAuth).mockReturnValue({
    session: {
      user: { id: "me", name: "Me", email: "me@example.com", is_operator: false },
      tenant: null,
      tenants: [],
      state: "ready",
      can_create_workspace: true,
      can_add_workspace: true,
      invite_email_enabled: false,
    },
    refresh,
  } as unknown as ReturnType<typeof useAuth>);
  return refresh;
}

function openMenu(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${name}` }));
  return screen.getByRole("menu");
}

function menuItems(name: string): { label: string; reason: string | null }[] {
  const menu = openMenu(name);
  const items = within(menu)
    .getAllByRole("menuitem")
    .map((item) => ({
      label: item.querySelector(".MuiListItemText-primary")?.textContent ?? "",
      reason:
        item.getAttribute("aria-disabled") === "true"
          ? (item.querySelector(".MuiListItemText-secondary")?.textContent ?? "")
          : null,
    }));
  fireEvent.keyDown(menu, { key: "Escape" });
  return items;
}

describe("OrganizationUsersPage", () => {
  beforeEach(signedIn);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows what a demotion could not revoke at a vendor", async () => {
    const bob = member({ user_id: "bob", name: "Bob", role: "org_admin" });
    answerFetch({
      "GET /organizations/current": [200, adminOrg()],
      "GET /organizations/current/members": [200, [bob]],
      "GET /organizations/current/workspaces": [200, []],
      "GET /organizations/current/issues": [200, []],
      "PATCH /organizations/current/members/bob": [
        200,
        { ...bob, role: "member", warning: "Acme Two: GitHub could not be revoked." },
      ],
    });

    render(<OrganizationUsersPage />);
    await screen.findByTestId("row-bob");

    fireEvent.click(within(openMenu("Bob")).getByText("Make Member"));
    fireEvent.click(screen.getByRole("button", { name: "Make Member" }));

    expect(await screen.findByText("Acme Two: GitHub could not be revoked.")).toBeTruthy();
  });

  it("lets the operator make an admin where there is none, and nothing more", async () => {
    const bob = member({ user_id: "bob", name: "Bob", can_grant_org_admin: true, can_remove: false });
    answerFetch({
      "GET /organizations/current": [200, operatorOrg()],
      "GET /organizations/current/members": [200, [bob]],
      "GET /organizations/current/issues": [200, []],
    });

    render(<OrganizationUsersPage />);
    await screen.findByTestId("row-bob");

    expect(menuItems("Bob")).toEqual([{ label: "Make Org admin", reason: null }]);
    expect(
      screen.getByText(
        /This organization has no admin\. As platform operator you can make one of its users an admin/,
      ),
    ).toBeTruthy();
  });

  it("tells the operator an organization from the account settings gets its admin there", async () => {
    const bob = member({ user_id: "bob", name: "Bob", can_grant_org_admin: false, can_remove: false });
    answerFetch({
      "GET /organizations/current": [200, operatorOrg({ members_from_directory: true })],
      "GET /organizations/current/members": [200, [bob]],
      "GET /organizations/current/issues": [200, []],
    });

    render(<OrganizationUsersPage />);
    await screen.findByTestId("row-bob");

    expect(await screen.findByText(/someone has to be made an organization admin there/)).toBeTruthy();
    expect(menuItems("Bob")).toEqual([
      {
        label: "Make Org Admin",
        reason: "Org admin is granted in your organization's account settings.",
      },
    ]);
  });

  it("tells the operator why where the organization has an admin, asking for no members", async () => {
    const calls = answerFetch({
      "GET /organizations/current": [200, operatorOrg({ can_manage_members: false })],
    });

    render(<OrganizationUsersPage />);

    expect(await screen.findByText(/only while it has no admin/)).toBeTruthy();
    const asked = calls.map((c) => c.path);
    expect(asked.filter((path) => path.endsWith("/issues") || path.endsWith("/members"))).toEqual([]);
  });

  it("reads the organization again once the operator has made an admin", async () => {
    const bob = member({ user_id: "bob", name: "Bob", can_grant_org_admin: true, can_remove: false });
    let hasAdmin = false;
    let organizationReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace(/^\/gateway/, "").split("?")[0];
        const key = `${init?.method ?? "GET"} ${path}`;
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
        if (key === "PATCH /organizations/current/members/bob") {
          hasAdmin = true;
          return json({ ...bob, role: "org_admin", warning: null });
        }
        if (key === "GET /organizations/current") {
          organizationReads += 1;
          return json(operatorOrg({ can_manage_members: !hasAdmin }));
        }
        if (key === "GET /organizations/current/members") {
          return hasAdmin ? json({ detail: "Only an organization admin may do this" }, 403) : json([bob]);
        }
        if (key === "GET /organizations/current/issues") {
          return json({ detail: "Only an organization admin may do this" }, 403);
        }
        return json({ detail: "Not Found" }, 404);
      }),
    );

    render(<OrganizationUsersPage />);
    await screen.findByTestId("row-bob");
    const readsBefore = organizationReads;

    fireEvent.click(within(openMenu("Bob")).getByText("Make Org admin"));
    fireEvent.click(screen.getByRole("button", { name: "Make Org admin" }));

    await waitFor(() => expect(organizationReads).toBeGreaterThan(readsBefore));
    expect(await screen.findByText(/only while it has no admin/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("row-bob")).toBeNull());
    expect(screen.queryByText(/This organization has no admin/)).toBeNull();
  });

  it("shows the operator a failure as a failure", async () => {
    answerFetch({
      "GET /organizations/current": [200, operatorOrg()],
      "GET /organizations/current/members": [500, { detail: "The database is unavailable" }],
      "GET /organizations/current/issues": [200, []],
    });

    render(<OrganizationUsersPage />);

    expect(await screen.findByText("The database is unavailable")).toBeTruthy();
    expect(screen.queryByText(/only while it has no admin/)).toBeNull();
  });

  it("says where an organization's members come from when it is not here", async () => {
    const bob = member({ user_id: "bob", name: "Bob", role: "member", can_grant_org_admin: false });
    const cy = member({ user_id: "cy", name: "Cy", role: "org_admin", can_grant_org_admin: false });
    answerFetch({
      "GET /organizations/current": [200, adminOrg({ members_from_directory: true })],
      "GET /organizations/current/members": [200, [bob, cy]],
      "GET /organizations/current/workspaces": [200, []],
      "GET /organizations/current/issues": [200, []],
    });

    render(<OrganizationUsersPage />);
    await screen.findByTestId("row-bob");

    expect(await screen.findByText(/come from your organization's account settings/)).toBeTruthy();
    expect(menuItems("Bob").find((item) => item.label === "Make Org Admin")?.reason).toBe(
      "Org admin is granted in your organization's account settings.",
    );
    expect(menuItems("Cy").find((item) => item.label === "Make Viewer")?.reason).toBeNull();
    expect(menuItems("Bob").find((item) => item.label === "Remove from organization")).toBeTruthy();
  });

  describe("where changes go to the organization's account settings", () => {
    const originalLocation = window.location;
    const bob = () => member({ user_id: "bob", name: "Bob", role: "member", can_grant_org_admin: true });
    const directoryRoutes = (patchAnswer: Answer): Record<string, Answer> => ({
      "GET /organizations/current": [
        200,
        adminOrg({ members_from_directory: true, directory_takes_changes: true }),
      ],
      "GET /organizations/current/members": [200, [bob()]],
      "GET /organizations/current/workspaces": [200, []],
      "GET /organizations/current/issues": [200, []],
      "PATCH /organizations/current/members/bob": patchAnswer,
    });
    const signInFirst: Answer = [403, {}];
    // `answerFetch` sends an answer's body as given; this replaces the PATCH
    // handler with one that returns WorkOS's structured `detail`.
    const structured = (detail: unknown) => {
      const fetchMock = vi.mocked(fetch);
      const original = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) => {
        if (init?.method === "PATCH") {
          return new Response(JSON.stringify({ detail }), { status: 403 });
        }
        return original(input, init);
      });
    };
    const promoteBob = async () => {
      await screen.findByTestId("row-bob");
      fireEvent.click(within(openMenu("Bob")).getByText("Make Org Admin"));
      fireEvent.click(screen.getByRole("button", { name: "Make Org Admin" }));
    };

    beforeEach(() => {
      window.sessionStorage.clear();
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: { ...originalLocation, href: "", pathname: "/settings/org/users" },
      });
    });

    afterEach(() => {
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: originalLocation,
      });
    });

    it("offers Org admin and says changes are made there too", async () => {
      answerFetch(directoryRoutes([200, { ...bob(), role: "org_admin", warning: null }]));

      render(<OrganizationUsersPage />);

      expect(await screen.findByText(/Changes you make here are made there too/)).toBeTruthy();
      await screen.findByTestId("row-bob");
      expect(menuItems("Bob").find((item) => item.label === "Make Org Admin")?.reason).toBeNull();
    });

    it("sends the admin to sign in there, keeping the change", async () => {
      answerFetch(directoryRoutes(signInFirst));
      structured({ error: "directory_sign_in_required", message: "Confirm your sign-in." });

      render(<OrganizationUsersPage />);
      await promoteBob();

      await waitFor(() =>
        expect(window.location.href).toBe(
          "/gateway/auth/workos/organization?return_to=%2Fsettings%2Forg%2Fusers",
        ),
      );
      expect(
        JSON.parse(window.sessionStorage.getItem("switch.pendingOrganizationMemberChange")!),
      ).toMatchObject({ change: { userId: "bob", role: "org_admin" }, organizationId: "org-1" });
    });

    it("comes back only to a dashboard path", async () => {
      window.location.pathname = "//elsewhere.example.test/settings/org/users";
      answerFetch(directoryRoutes(signInFirst));
      structured({ error: "directory_sign_in_required", message: "Confirm your sign-in." });

      render(<OrganizationUsersPage />);
      await promoteBob();

      await waitFor(() =>
        expect(window.location.href).toBe(
          "/gateway/auth/workos/organization?return_to=%2Forganization",
        ),
      );
    });

    it("says what was already taken away before sending the admin to sign in", async () => {
      answerFetch(directoryRoutes(signInFirst));
      structured({
        error: "directory_sign_in_required",
        message: "Your sign-in has ended. Access was already taken away.",
        access_ended: true,
      });

      render(<OrganizationUsersPage />);
      await promoteBob();

      expect(
        await screen.findByText("Your sign-in has ended. Access was already taken away."),
      ).toBeTruthy();
      expect(window.location.href).toBe("");
      fireEvent.click(screen.getByRole("button", { name: "Confirm sign-in to finish" }));
      expect(window.location.href).toBe(
        "/gateway/auth/workos/organization?return_to=%2Fsettings%2Forg%2Fusers",
      );
    });

    const keep = (organizationId: string, savedAt: number) =>
      window.sessionStorage.setItem(
        "switch.pendingOrganizationMemberChange",
        JSON.stringify({ change: { userId: "bob", role: "org_admin" }, organizationId, savedAt }),
      );
    const patched = (calls: Call[]) => calls.some((c) => c.method === "PATCH");

    it("drops a kept change from another organization, or one too old", async () => {
      for (const [organizationId, savedAt] of [
        ["org-2", Date.now()],
        ["org-1", Date.now() - 11 * 60 * 1000],
      ] as const) {
        keep(organizationId, savedAt);
        const calls = answerFetch(directoryRoutes([200, { ...bob(), role: "org_admin", warning: null }]));

        const { unmount } = render(<OrganizationUsersPage />);
        await screen.findByTestId("row-bob");

        expect(patched(calls)).toBe(false);
        expect(window.sessionStorage.getItem("switch.pendingOrganizationMemberChange")).toBeNull();
        unmount();
      }
    });

    it("makes the kept change on coming back", async () => {
      keep("org-1", Date.now());
      const calls = answerFetch(directoryRoutes([200, { ...bob(), role: "org_admin", warning: null }]));

      render(<OrganizationUsersPage />);

      await waitFor(() =>
        expect(
          calls.some((c) => c.method === "PATCH" && c.path === "/organizations/current/members/bob"),
        ).toBe(true),
      );
      expect(window.sessionStorage.getItem("switch.pendingOrganizationMemberChange")).toBeNull();
    });

    it("shows a kept change that still asks for a sign-in as a failure", async () => {
      keep("org-1", Date.now());
      answerFetch(directoryRoutes(signInFirst));
      structured({ error: "directory_sign_in_required", message: "Confirm your sign-in." });

      render(<OrganizationUsersPage />);

      expect(await screen.findByText("Confirm your sign-in.")).toBeTruthy();
      expect(window.location.href).toBe("");
    });
  });

  it("says nothing of account settings for an organization kept here", async () => {
    const bob = member({ user_id: "bob", name: "Bob", can_grant_org_admin: true });
    answerFetch({
      "GET /organizations/current": [200, adminOrg()],
      "GET /organizations/current/members": [200, [bob]],
      "GET /organizations/current/workspaces": [200, []],
      "GET /organizations/current/issues": [200, []],
    });

    render(<OrganizationUsersPage />);
    await screen.findByTestId("row-bob");

    expect(menuItems("Bob").find((item) => item.label === "Make Org admin")?.reason).toBeNull();
    expect(screen.queryByText(/account settings/)).toBeNull();
  });

  it("tells an organization admin what needs their attention", async () => {
    answerFetch({
      "GET /organizations/current": [200, adminOrg()],
      "GET /organizations/current/members": [200, []],
      "GET /organizations/current/workspaces": [200, []],
      "GET /organizations/current/issues": [
        200,
        [
          { kind: "workspace_without_admin", workspace_id: "t1", workspace_name: "Acme", agents: [] },
          {
            kind: "agents_without_acting_owner",
            workspace_id: "t1",
            workspace_name: "Acme",
            agents: ["reviewer", "triage"],
          },
        ],
      ],
    });

    render(<OrganizationUsersPage />);

    expect(await screen.findByText("2 things need your attention")).toBeTruthy();
    expect(screen.getByText(/Acme has no admin/)).toBeTruthy();
    expect(screen.getByText(/reviewer, triage/)).toBeTruthy();
  });

  it("checks again after a change to the members", async () => {
    const bob = member({ user_id: "bob", name: "Bob" });
    answerFetch({
      "GET /organizations/current": [200, adminOrg()],
      "GET /organizations/current/members": [200, [bob]],
      "GET /organizations/current/workspaces": [200, []],
      "GET /organizations/current/issues": [
        [200, []],
        [
          200,
          [
            {
              kind: "agents_without_acting_owner",
              workspace_id: "t1",
              workspace_name: "Acme",
              agents: ["triage"],
            },
          ],
        ],
      ],
      "DELETE /organizations/current/members/bob": [200, { warning: null }],
    });

    render(<OrganizationUsersPage />);
    await screen.findByTestId("row-bob");

    fireEvent.click(within(openMenu("Bob")).getByText("Remove from organization"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(await screen.findByText("One thing needs your attention")).toBeTruthy();
    expect(screen.getByText(/triage/)).toBeTruthy();
  });

  it("says nothing when nothing needs attention", async () => {
    answerFetch({
      "GET /organizations/current": [200, adminOrg()],
      "GET /organizations/current/members": [200, []],
      "GET /organizations/current/workspaces": [200, []],
      "GET /organizations/current/issues": [200, []],
    });

    render(<OrganizationUsersPage />);

    await screen.findByRole("heading", { name: "Users" });
    expect(screen.queryByText(/need(s)? your attention/)).toBeNull();
  });

  it("shows a failure to check as a failure", async () => {
    answerFetch({
      "GET /organizations/current": [200, adminOrg()],
      "GET /organizations/current/members": [200, []],
      "GET /organizations/current/workspaces": [200, []],
      "GET /organizations/current/issues": [500, { detail: "The database is unavailable" }],
    });

    render(<OrganizationUsersPage />);

    expect(await screen.findByText(/Could not check this organization for problems/)).toBeTruthy();
  });
});
