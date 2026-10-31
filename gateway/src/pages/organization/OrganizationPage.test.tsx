import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
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
function answer(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/gateway/, "").split("?")[0];
    const key = `${init?.method ?? "GET"} ${path}`;
    if (!(key in routes)) {
      return new Response(JSON.stringify({ detail: `unmocked ${key}` }), { status: 404 });
    }
    const answered = routes[key];
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

function signedInAs(current: Session) {
  const refresh = vi.fn();
  vi.mocked(useAuth).mockReturnValue({
    session: current,
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
});

describe("OrganizationPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows an organization admin its members and audit log", async () => {
    signedInAs(session("org_admin", true));
    answer({
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin" },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [
        { user_id: "u2", name: "Bob", email: "bob@example.com", role: "member", created_at: "2026-01-01" },
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
      ],
    });

    render(<OrganizationPage />);

    expect(await screen.findByText("Acme Inc")).toBeTruthy();
    expect(await screen.findByText("Acme (current)")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Members" })).toBeTruthy();
    expect(await screen.findByText("Organization role changed")).toBeTruthy();
    expect(screen.getByText("Olga (platform operator)")).toBeTruthy();
  });

  it("shows an organization admin its connector apps, and changes them as its own", async () => {
    signedInAs(session("org_admin", true));
    const fetchMock = answer({
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin" },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [],
      "GET /organizations/current/audit-events": [],
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
      screen.getByText(
        "Your workspaces use the server's Airtable client. Add your organization's own to use that instead.",
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

  it("shows no connectors where the server keeps them to itself", async () => {
    signedInAs(session("org_admin", true));
    const fetchMock = answer({
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin" },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [],
      "GET /organizations/current/audit-events": [],
    });

    render(<OrganizationPage />);

    expect(await screen.findByRole("heading", { name: "Members" })).toBeTruthy();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/gateway/organizations/current/connector-apps",
        expect.anything(),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
    expect(screen.queryByRole("heading", { name: "Connectors" })).toBeNull();
    expect(screen.queryByText(/unmocked/)).toBeNull();
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
    };
    answer({
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin" },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [bob],
      "GET /organizations/current/audit-events": [],
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
    expect(screen.queryByRole("heading", { name: "Members" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Audit log" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add workspace" })).toBeNull();
  });

  it("adds a workspace, lists it, and refreshes the session", async () => {
    const refresh = signedInAs(session("org_admin", true));
    const routes: Record<string, unknown> = {
      "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: "org_admin" },
      "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
      "GET /organizations/current/members": [],
      "GET /organizations/current/audit-events": [],
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
    { user_id: "u2", name: "Bob", email: "bob@example.com", role: "member", created_at: "2026-01-01" },
  ];
  const operatorRoutes = (membersAnswer: unknown) => ({
    "GET /organizations/current": { id: "o1", slug: "acme", name: "Acme Inc", role: null },
    "GET /organizations/current/workspaces": [workspace("t1", "Acme")],
    "GET /organizations/current/members": membersAnswer,
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

  it("tells the operator why where the organization has an admin", async () => {
    signedInAs(session(null, false, true));
    answer(operatorRoutes(new Refusal(403, "Only an organization admin may do this")));

    render(<OrganizationPage />);

    expect(await screen.findByText(/only while it has no admin/)).toBeTruthy();
    expect(screen.queryByText("Only an organization admin may do this")).toBeNull();
  });

  it("shows the operator a failure as a failure", async () => {
    signedInAs(session(null, false, true));
    answer(operatorRoutes(new Refusal(500, "The database is unavailable")));

    render(<OrganizationPage />);

    expect(await screen.findByText("The database is unavailable")).toBeTruthy();
    expect(screen.queryByText(/only while it has no admin/)).toBeNull();
  });
});
