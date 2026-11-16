import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { capabilitiesOf } from "../../data/capabilities";
import { ALL_OFF, type FeatureFlags } from "../../data/featureFlags";
import { app } from "../connector-apps/testFixtures";
import OrganizationPage from "./OrganizationPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

vi.mock("../../components/DataTable", () => import("../../test/FakeDataTable"));

function session(
  organizationRole: "org_admin" | "member" | null,
  canAdd: boolean,
  isOperator = false,
): Session {
  const tenant = {
    id: "t1",
    slug: "acme",
    name: "Acme",
    role: organizationRole === "member" ? ("member" as const) : ("admin" as const),
    organization_role: organizationRole,
    organization_id: "o1",
    archived_at: null,
  };
  return {
    user: { id: "u1", name: "Ada", email: "ada@example.com", is_operator: isOperator },
    tenant,
    tenants: [tenant],
    state: "ready",
    can_create_workspace: true,
    can_add_workspace: canAdd,
    invite_email_enabled: false,
  };
}

/** Answers each `METHOD /path` from `routes`: a body, or `[status, body]`
 * for a refusal. */
/** What an organization with no Switch Trust policy answers, for the
 * Guardrails section an admin sees, unless a test says otherwise. */
const NO_GUARDRAILS = {
  connected: false,
  policy_id: null,
  policy_name: null,
  policy_url: null,
  api_key_last4: null,
  connected_by_name: null,
  connected_at: null,
};

function answer(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/gateway/, "").split("?")[0];
    const key = `${init?.method ?? "GET"} ${path}`;
    if (key === "GET /organizations/current/guardrails" && !(key in routes)) {
      return new Response(JSON.stringify(NO_GUARDRAILS), { status: 200 });
    }
    if (!(key in routes)) {
      return new Response(JSON.stringify({ detail: `unmocked ${key}` }), { status: 404 });
    }
    let answered = routes[key];
    // The organization's own answers, as the server gives them to someone
    // holding that role, unless the test says otherwise.
    if (key === "GET /organizations/current" && !(answered instanceof Refusal)) {
      const organization = answered as Record<string, unknown>;
      const admin = organization.role === "org_admin";
      answered = { administers: admin, can_manage_members: admin, ...organization };
    }
    if (answered instanceof Refusal) {
      return new Response(JSON.stringify({ detail: answered.detail }), {
        status: answered.status,
      });
    }
    return new Response(JSON.stringify(answered), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

class Refusal {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {}
}

const CONNECTORS_ON: FeatureFlags = {
  ...ALL_OFF,
  service_connections: true,
  organization_connector_apps: true,
};

function signedInAs(current: Session, features: FeatureFlags = CONNECTORS_ON) {
  const refresh = vi.fn();
  const administers = current.tenant?.role === "admin" || current.user.is_operator;
  vi.mocked(useAuth).mockReturnValue({
    session: current,
    capabilities: capabilitiesOf(
      current,
      {
        id: "t1",
        slug: "acme",
        name: "Acme",
        role: current.tenant?.role ?? "member",
        administers,
        can_delete: false,
        can_manage_data_protection: false,
      },
      features,
    ),
    switchTo: vi.fn(),
    refresh,
  } as unknown as ReturnType<typeof useAuth>);
  return refresh;
}

const workspace = (id: string, name: string) => ({
  id,
  slug: id,
  name,
  role: "admin",
  organization_role: "org_admin",
  organization_id: "o1",
  archived_at: null,
});

describe("OrganizationPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows an organization admin its members and audit log", async () => {
    signedInAs(session("org_admin", true));
    answer({
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin", members_from_directory: false },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [
        { user_id: "u2", name: "Bob", email: "bob@example.com", role: "member", created_at: "2026-01-01", can_change_role: true, can_grant_org_admin: true, can_remove: true },
      ],
      "GET /organizations/current/audit-events": [
        {
          id: "e1",
          occurred_at: "2026-01-02",
          actor_user_id: "op",
          actor_name: "Olga",
          action: "organization.role_changed",
          target_type: "user",
          target_id: "u2",
          target_name: "Bob",
          details: { from: "member", to: "org_admin", platform_access: true },
        },
        {
          id: "e2",
          occurred_at: "2026-01-03",
          actor_user_id: "u2",
          actor_name: "Bob",
          action: "organization.workspace_renamed",
          target_type: "workspace",
          target_id: "t1",
          target_name: null,
          details: { name: "Research", previous_name: "Acme" },
        },
      ],
      "GET /organizations/current/issues": [],
    });

    render(<OrganizationPage />);

    expect(await screen.findByText("Acme Inc")).toBeTruthy();
    expect(await screen.findByText("Acme (current)")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Users" })).toBeTruthy();
    expect(await screen.findByText("Organization role changed")).toBeTruthy();
    expect(screen.getByText("Olga (platform operator)")).toBeTruthy();
    // A rename is of the workspace by its new name, not its id.
    expect(screen.getByText("Workspace renamed")).toBeTruthy();
    expect(screen.getByText("Research")).toBeTruthy();
  });

  it("shows an organization admin its connector apps, and changes them as its own", async () => {
    signedInAs(session("org_admin", true));
    const fetchMock = answer({
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin" },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [],
      "GET /organizations/current/audit-events": [],
      "GET /organizations/current/services": { workspaces: 1, services: [] },
      "GET /organizations/current/connector-apps": {
        public_url: "https://switch.example.test",
        apps: [
          app({ server_app: true }),
          app({
            slug: "airtable",
            name: "Airtable",
            source: "none",
            client_id: null,
            saved_client_id: null,
            secrets: { client_secret: { set: false, last4: null } },
            connected_members: 0,
            workspaces: 0,
            server_app: true,
          }),
        ],
      },
      "POST /organizations/current/connector-apps/google-workspace/check": { ok: true, checks: [] },
    });

    render(<OrganizationPage />);

    expect(await screen.findByRole("heading", { name: "Connectors" })).toBeTruthy();
    expect(
      await screen.findByText(
        "Your workspaces use Switch's Airtable client. Add your organization's own to use that instead.",
      ),
    ).toBeTruthy();
    const google = screen.getByTestId("connector-app-google-workspace");
    fireEvent.click(within(google).getByRole("button", { name: "Check it works" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/gateway/organizations/current/connector-apps/google-workspace/check",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("lets an organization admin switch a service off and lock it for every workspace", async () => {
    signedInAs(session("org_admin", true));
    const github = {
      slug: "github",
      name: "GitHub",
      setting: null,
      updated_by_name: null,
      updated_at: null,
      server_switched_off: null,
      workspaces_on: 2,
      workspaces_set_own: 1,
      connected_members: 3,
    };
    const fetchMock = answer({
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin" },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [],
      "GET /organizations/current/audit-events": [],
      "GET /organizations/current/connector-apps": { public_url: null, apps: [] },
      "GET /organizations/current/services": { workspaces: 3, services: [github] },
      "PUT /organizations/current/services/github": { warning: null },
    });

    render(<OrganizationPage />);

    const card = await screen.findByTestId("organization-service-github");
    expect(within(card).getByText("On in 2 of 3 workspaces · 1 sets its own · 3 people connected")).toBeTruthy();
    expect((within(card).getByLabelText("Lock GitHub") as HTMLInputElement).disabled).toBe(true);
    fireEvent.mouseDown(within(card).getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Off" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/gateway/organizations/current/services/github",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ enabled: false, locked: false }),
        }),
      ),
    );
  });

  it("shows no connectors where the server keeps them to itself, and asks nothing of it", async () => {
    signedInAs(session("org_admin", true), { ...ALL_OFF, service_connections: true });
    const fetchMock = answer({
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin" },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [],
      "GET /organizations/current/audit-events": [],
      "GET /organizations/current/issues": [],
    });

    render(<OrganizationPage />);

    expect(await screen.findByRole("heading", { name: "Users" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
    expect(screen.queryByRole("heading", { name: "Connectors" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Services" })).toBeNull();
    const asked = fetchMock.mock.calls.map(([input]) => String(input));
    expect(asked.filter((url) => /current\/(services|connector-apps)|feature-flags/.test(url))).toEqual([]);
    expect(screen.queryByText(/unmocked/)).toBeNull();
  });

  it("lets an admin set the organization's guardrails, the only place they are set", async () => {
    signedInAs(session("org_admin", true));
    answer({
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin" },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [],
      "GET /organizations/current/audit-events": [],
      "GET /organizations/current/issues": [],
    });

    render(<OrganizationPage />);

    expect(await screen.findByRole("heading", { name: "Guardrails" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Set up" })).toBeTruthy();
  });

  it("shows what a demotion could not revoke at a vendor", async () => {
    signedInAs(session("org_admin", true));
    const bob = {
      user_id: "u2",
      name: "Bob",
      email: "bob@example.com",
      role: "org_admin",
      created_at: "2026-01-01",
      warning: null,
      can_change_role: true,
      can_grant_org_admin: true,
      can_remove: true,
    };
    answer({
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin", members_from_directory: false },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [bob],
      "GET /organizations/current/audit-events": [],
      "GET /organizations/current/issues": [],
      "PATCH /organizations/current/members/u2": {
        ...bob,
        role: "member",
        warning: "Acme Two: GitHub could not be revoked.",
      },
    });

    render(<OrganizationPage />);

    const row = await screen.findByTestId("row-u2");
    fireEvent.mouseDown(within(row).getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Member" }));

    expect(await screen.findByText("Acme Two: GitHub could not be revoked.")).toBeTruthy();
  });

  it("shows a member only the workspaces, with nothing to add", async () => {
    signedInAs(session("member", false));
    answer({
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "member" },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
    });

    render(<OrganizationPage />);

    expect(await screen.findByText("Acme (current)")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Users" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Audit log" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add workspace" })).toBeNull();
  });

  it("adds a workspace, lists it, and refreshes the session", async () => {
    const refresh = signedInAs(session("org_admin", true));
    const routes: Record<string, unknown> = {
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin", members_from_directory: false },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [],
      "GET /organizations/current/audit-events": [],
      "GET /organizations/current/issues": [],
      "POST /organizations/current/workspaces": workspace("t2", "Research"),
    };
    const fetchMock = answer(routes);

    render(<OrganizationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add workspace" }));
    fireEvent.change(screen.getByLabelText(/Workspace name/), { target: { value: "Research" } });
    routes["GET /organizations/current/workspaces"] = [
      workspace("t1", "Acme"),
      workspace("t2", "Research"),
    ];
    fireEvent.click(screen.getAllByRole("button", { name: "Add workspace" }).at(-1)!);

    expect(await screen.findByText("Research")).toBeTruthy();
    const posted = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(posted?.[1]?.body))).toEqual({ name: "Research" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(refresh).toHaveBeenCalled();
  });

  const members = [
    { user_id: "u2", name: "Bob", email: "bob@example.com", role: "member", created_at: "2026-01-01", can_change_role: true, can_remove: false },
  ];
  // The operator restoring an admin may change roles and remove nobody; who may
  // be made Org Admin follows where the members come from.
  // The server lets the operator manage the members only while there is no
  // admin, and says so in `can_manage_members`.
  const operatorRoutes = (membersAnswer: unknown, fromDirectory = false) => ({
    "GET /organizations/current": {
      id: "o1",
      slug: "acme",
      name: "Acme Inc",
      role: null,
      members_from_directory: fromDirectory,
      can_manage_members: !(membersAnswer instanceof Refusal && membersAnswer.status === 403),
    },
    "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
    "GET /organizations/current/members": Array.isArray(membersAnswer)
      ? membersAnswer.map((m) => ({ ...m, can_grant_org_admin: !fromDirectory }))
      : membersAnswer,
    "GET /organizations/current/issues": new Refusal(403, "Only an organization admin may do this"),
  });

  it("lets the operator make an admin where there is none, and nothing more", async () => {
    signedInAs(session(null, false, true));
    answer(operatorRoutes(members));

    render(<OrganizationPage />);

    expect(await screen.findByLabelText("Organization role for bob@example.com")).toBeTruthy();
    expect(screen.queryByLabelText("Remove bob@example.com from the organization")).toBeNull();
    expect(screen.getByText(/This organization has no admin/)).toBeTruthy();
    expect(screen.getByText(/You are here as platform operator/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Audit log" })).toBeNull();
  });

  it("tells the operator an organization from the account settings gets its admin there", async () => {
    signedInAs(session(null, false, true));
    answer(operatorRoutes(members, true));

    render(<OrganizationPage />);

    expect(await screen.findByText(/someone has to be made an organization admin there/)).toBeTruthy();
    fireEvent.mouseDown(within(await screen.findByTestId("row-u2")).getByRole("combobox"));
    const orgAdmin = await screen.findByRole("option", { name: "Org admin" });
    expect(orgAdmin.getAttribute("aria-disabled")).toBe("true");
  });

  it("tells the operator why where the organization has an admin, asking for no members", async () => {
    signedInAs(session(null, false, true));
    const fetchMock = answer(operatorRoutes(new Refusal(403, "Only an organization admin may do this")));

    render(<OrganizationPage />);

    expect(await screen.findByText(/only while it has no admin/)).toBeTruthy();
    expect(screen.queryByText("Only an organization admin may do this")).toBeNull();
    const asked = fetchMock.mock.calls.map(([input]) => String(input));
    expect(asked.filter((path) => path.endsWith("/issues") || path.endsWith("/members"))).toEqual([]);
  });

  it("reads the organization again once the operator has made an admin", async () => {
    signedInAs(session(null, false, true));
    let hasAdmin = false;
    let organizationReads = 0;
    const routes = operatorRoutes(members);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace(/^\/gateway/, "").split("?")[0];
        const key = `${init?.method ?? "GET"} ${path}`;
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status });
        if (key === "PATCH /organizations/current/members/u2") {
          hasAdmin = true;
          return json({ ...members[1], role: "org_admin", warning: null });
        }
        if (key === "GET /organizations/current") {
          organizationReads += 1;
          return json({
            ...routes["GET /organizations/current"],
            administers: false,
            can_manage_members: !hasAdmin,
          });
        }
        if (key === "GET /organizations/current/members") {
          return hasAdmin
            ? json({ detail: "Only an organization admin may do this" }, 403)
            : json(routes[key]);
        }
        if (key in routes && !(routes[key as keyof typeof routes] instanceof Refusal)) {
          return json(routes[key as keyof typeof routes]);
        }
        return json({ detail: "Not Found" }, 404);
      }),
    );

    render(<OrganizationPage />);

    const row = await screen.findByTestId("row-u2");
    const readsBefore = organizationReads;
    fireEvent.mouseDown(within(row).getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Org admin" }));

    await waitFor(() => expect(organizationReads).toBeGreaterThan(readsBefore));
    expect(await screen.findByText(/only while it has no admin/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("row-u2")).toBeNull());
    expect(screen.queryByText(/This organization has no admin/)).toBeNull();
  });

  it("shows the operator a failure as a failure", async () => {
    signedInAs(session(null, false, true));
    answer(operatorRoutes(new Refusal(500, "The database is unavailable")));

    render(<OrganizationPage />);

    expect(await screen.findByText("The database is unavailable")).toBeTruthy();
    expect(screen.queryByText(/only while it has no admin/)).toBeNull();
  });

  it("says where an organization's members come from when it is not here", async () => {
    signedInAs(session("org_admin", true));
    answer({
      "GET /organizations/current": {
        id: "o1",
        slug: "acme",
        name: "Acme Inc",
        role: "org_admin",
        members_from_directory: true,
      },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [
        { user_id: "u2", name: "Bob", email: "bob@example.com", role: "member", created_at: "2026-01-01", can_change_role: true, can_grant_org_admin: false, can_remove: true },
        { user_id: "u3", name: "Cy", email: "cy@example.com", role: "org_admin", created_at: "2026-01-01", can_change_role: true, can_grant_org_admin: false, can_remove: true },
      ],
      "GET /organizations/current/audit-events": [],
      "GET /organizations/current/issues": [],
    });

    render(<OrganizationPage />);

    expect(await screen.findByText(/come from your organization's account settings/)).toBeTruthy();
    fireEvent.mouseDown(within(await screen.findByTestId("row-u2")).getByRole("combobox"));
    const promote = await screen.findByRole("option", { name: "Org admin" });
    expect(promote.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(promote, { key: "Escape" });
    fireEvent.mouseDown(within(screen.getByTestId("row-u3")).getByRole("combobox"));
    const demote = await screen.findByRole("option", { name: "Member" });
    expect(demote.getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByLabelText("Remove bob@example.com from the organization")).toBeTruthy();
  });

  describe("where changes go to the organization's account settings", () => {
    const originalLocation = window.location;
    const bob = { user_id: "u2", name: "Bob", email: "bob@example.com", role: "member", created_at: "2026-01-01", can_change_role: true, can_grant_org_admin: true, can_remove: true };
    const routes = (patchAnswer: unknown) => ({
      "GET /organizations/current": {
        id: "o1",
        slug: "acme",
        name: "Acme Inc",
        role: "org_admin",
        members_from_directory: true,
        directory_takes_changes: true,
      },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [bob],
      "GET /organizations/current/audit-events": [],
      "GET /organizations/current/issues": [],
      "PATCH /organizations/current/members/u2": patchAnswer,
    });
    const signInFirst = new Refusal(403, "");
    // `answer` sends a refusal's detail as a string; this one is structured.
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

    beforeEach(() => {
      window.sessionStorage.clear();
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: { ...originalLocation, href: "", pathname: "/organization" },
      });
    });

    afterEach(() => {
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: originalLocation,
      });
    });

    it("offers Org Admin and says changes are made there too", async () => {
      signedInAs(session("org_admin", true));
      answer(routes({ ...bob, role: "org_admin", warning: null }));

      render(<OrganizationPage />);

      expect(await screen.findByText(/Changes you make here are made there too/)).toBeTruthy();
      fireEvent.mouseDown(within(await screen.findByTestId("row-u2")).getByRole("combobox"));
      const promote = await screen.findByRole("option", { name: "Org admin" });
      expect(promote.getAttribute("aria-disabled")).toBeNull();
    });

    it("sends the admin to sign in there, keeping the change", async () => {
      signedInAs(session("org_admin", true));
      answer(routes(signInFirst));
      structured({ error: "directory_sign_in_required", message: "Confirm your sign-in." });

      render(<OrganizationPage />);
      fireEvent.mouseDown(within(await screen.findByTestId("row-u2")).getByRole("combobox"));
      fireEvent.click(await screen.findByRole("option", { name: "Org admin" }));

      await waitFor(() =>
        expect(window.location.href).toBe(
          "/gateway/auth/workos/organization?return_to=%2Forganization",
        ),
      );
      expect(
        JSON.parse(window.sessionStorage.getItem("switch.pendingOrganizationMemberChange")!),
      ).toMatchObject({ change: { userId: "u2", role: "org_admin" }, organizationId: "o1" });
    });

    it("comes back only to a dashboard path", async () => {
      window.location.pathname = "//elsewhere.example.test/organization";
      signedInAs(session("org_admin", true));
      answer(routes(signInFirst));
      structured({ error: "directory_sign_in_required", message: "Confirm your sign-in." });

      render(<OrganizationPage />);
      fireEvent.mouseDown(within(await screen.findByTestId("row-u2")).getByRole("combobox"));
      fireEvent.click(await screen.findByRole("option", { name: "Org admin" }));

      await waitFor(() =>
        expect(window.location.href).toBe(
          "/gateway/auth/workos/organization?return_to=%2Forganization",
        ),
      );
    });

    it("says what was already taken away before sending the admin to sign in", async () => {
      signedInAs(session("org_admin", true));
      answer(routes(signInFirst));
      structured({
        error: "directory_sign_in_required",
        message: "Your sign-in has ended. Access was already taken away.",
        access_ended: true,
      });

      render(<OrganizationPage />);
      fireEvent.mouseDown(within(await screen.findByTestId("row-u2")).getByRole("combobox"));
      fireEvent.click(await screen.findByRole("option", { name: "Org admin" }));

      expect(
        await screen.findByText("Your sign-in has ended. Access was already taken away."),
      ).toBeTruthy();
      expect(window.location.href).toBe("");
      fireEvent.click(screen.getByRole("button", { name: "Confirm sign-in to finish" }));
      expect(window.location.href).toBe(
        "/gateway/auth/workos/organization?return_to=%2Forganization",
      );
    });

    const keep = (organizationId: string, savedAt: number) =>
      window.sessionStorage.setItem(
        "switch.pendingOrganizationMemberChange",
        JSON.stringify({ change: { userId: "u2", role: "org_admin" }, organizationId, savedAt }),
      );
    const patched = (fetchMock: ReturnType<typeof answer>) =>
      fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH");

    it("drops a kept change from another organization, or one too old", async () => {
      for (const [organizationId, savedAt] of [
        ["o2", Date.now()],
        ["o1", Date.now() - 11 * 60 * 1000],
      ] as const) {
        keep(organizationId, savedAt);
        signedInAs(session("org_admin", true));
        const fetchMock = answer(routes({ ...bob, role: "org_admin", warning: null }));

        const { unmount } = render(<OrganizationPage />);
        await screen.findByTestId("row-u2");

        expect(patched(fetchMock)).toBe(false);
        expect(window.sessionStorage.getItem("switch.pendingOrganizationMemberChange")).toBeNull();
        unmount();
      }
    });

    it("makes the kept change on coming back", async () => {
      keep("o1", Date.now());
      signedInAs(session("org_admin", true));
      const fetchMock = answer(routes({ ...bob, role: "org_admin", warning: null }));

      render(<OrganizationPage />);

      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input, init]) =>
              init?.method === "PATCH" && String(input).endsWith("/organizations/current/members/u2"),
          ),
        ).toBe(true),
      );
      expect(window.sessionStorage.getItem("switch.pendingOrganizationMemberChange")).toBeNull();
    });

    it("shows a kept change that still asks for a sign-in as a failure", async () => {
      keep("o1", Date.now());
      signedInAs(session("org_admin", true));
      answer(routes(signInFirst));
      structured({ error: "directory_sign_in_required", message: "Confirm your sign-in." });

      render(<OrganizationPage />);

      expect(await screen.findByText("Confirm your sign-in.")).toBeTruthy();
      expect(window.location.href).toBe("");
    });
  });

  it("says nothing of account settings for an organization kept here", async () => {
    signedInAs(session("org_admin", true));
    answer({
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin", members_from_directory: false },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [
        { user_id: "u2", name: "Bob", email: "bob@example.com", role: "member", created_at: "2026-01-01", can_change_role: true, can_grant_org_admin: true, can_remove: true },
      ],
      "GET /organizations/current/audit-events": [],
      "GET /organizations/current/issues": [],
    });

    render(<OrganizationPage />);

    fireEvent.mouseDown(within(await screen.findByTestId("row-u2")).getByRole("combobox"));
    const promote = await screen.findByRole("option", { name: "Org admin" });
    expect(promote.getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByText(/account settings/)).toBeNull();
  });

  it("tells an organization admin what needs their attention", async () => {
    signedInAs(session("org_admin", true));
    answer({
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin", members_from_directory: false },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [],
      "GET /organizations/current/audit-events": [],
      "GET /organizations/current/issues": [
        { kind: "workspace_without_admin", workspace_id: "t1", workspace_name: "Acme", agents: [] },
        {
          kind: "agents_without_acting_owner",
          workspace_id: "t1",
          workspace_name: "Acme",
          agents: ["reviewer", "triage"],
        },
      ],
    });

    render(<OrganizationPage />);

    expect(await screen.findByText("2 things need your attention")).toBeTruthy();
    expect(screen.getByText(/Acme has no admin/)).toBeTruthy();
    expect(screen.getByText(/reviewer, triage/)).toBeTruthy();
  });

  it("checks again after a change to the members", async () => {
    signedInAs(session("org_admin", true));
    const routes: Record<string, unknown> = {
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin", members_from_directory: false },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [
        { user_id: "u2", name: "Bob", email: "bob@example.com", role: "member", created_at: "2026-01-01", can_change_role: true, can_grant_org_admin: true, can_remove: true },
      ],
      "GET /organizations/current/audit-events": [],
      "GET /organizations/current/issues": [],
      "DELETE /organizations/current/members/u2": { warning: null },
    };
    answer(routes);

    render(<OrganizationPage />);
    const remove = await screen.findByRole("button", { name: "Remove bob@example.com from the organization" });
    routes["GET /organizations/current/issues"] = [
      { kind: "agents_without_acting_owner", workspace_id: "t1", workspace_name: "Acme", agents: ["triage"] },
    ];
    fireEvent.click(remove);

    expect(await screen.findByText("One thing needs your attention")).toBeTruthy();
    expect(screen.getByText(/triage/)).toBeTruthy();
  });

  it("says nothing when nothing needs attention", async () => {
    signedInAs(session("org_admin", true));
    answer({
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin", members_from_directory: false },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [],
      "GET /organizations/current/audit-events": [],
      "GET /organizations/current/issues": [],
    });

    render(<OrganizationPage />);

    expect(await screen.findByText("Acme (current)")).toBeTruthy();
    expect(screen.queryByText(/need(s)? your attention/)).toBeNull();
  });

  it("shows a failure to check as a failure", async () => {
    signedInAs(session("org_admin", true));
    answer({
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin", members_from_directory: false },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [],
      "GET /organizations/current/audit-events": [],
      "GET /organizations/current/issues": new Refusal(500, "The database is unavailable"),
    });

    render(<OrganizationPage />);

    expect(await screen.findByText(/Could not check this organization for problems/)).toBeTruthy();
  });
});
