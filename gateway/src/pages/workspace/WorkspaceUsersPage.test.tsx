import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorkspaceUsersPage from "./WorkspaceUsersPage";

vi.mock("../../components/DataTable", () => import("../../test/FakeDataTable"));

const auth = vi.hoisted(() => ({ administers: false, organizationAdmin: false }));
vi.mock("../../data/AuthContext", () => ({
  useAuth: () => ({
    session: {
      user: { id: "me", name: "Me", email: "me@example.com", is_operator: false },
      tenant: {
        id: "t1",
        slug: "acme",
        name: "Acme",
        role: auth.administers ? "admin" : "member",
        organization_role: auth.organizationAdmin ? "org_admin" : "member",
        organization_id: "o1",
      },
      invite_email_enabled: false,
    },
    capabilities: {
      isOperator: false,
      administersWorkspace: auth.administers,
      administersOrganization: auth.organizationAdmin,
      inOrganization: true,
      canDeleteWorkspace: false,
      canManageDataProtection: false,
      features: {},
    },
    refresh: vi.fn(),
  }),
}));

const ROSTER = [
  {
    user_id: "me",
    name: "Me",
    email: "me@example.com",
    role: "member",
    created_at: "2026-01-01",
    service_account: false,
    organization_role: "member",
    via_organization: false,
    can_change_role: false,
    change_role_blocked_reason: null,
    can_remove: false,
    remove_blocked_reason: null,
    can_receive_transfer: false,
  },
];

function stubFetch() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/members")) return new Response(JSON.stringify(ROSTER));
    if (url.includes("/invitations")) return new Response("[]");
    if (url.includes("/organizations/current"))
      return new Response(JSON.stringify({ members_from_directory: false }));
    return new Response("{}");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  render(
    <MemoryRouter>
      <WorkspaceUsersPage />
    </MemoryRouter>,
  );
}

describe("WorkspaceUsersPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a member the roster alone, and who to ask for an invitation", async () => {
    auth.administers = false;
    const fetchMock = stubFetch();
    renderPage();

    expect(await screen.findByText("me@example.com")).toBeTruthy();
    expect(screen.getByText(/Ask a workspace admin to invite someone/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Invite users" })).toBeNull();
    expect(screen.queryByText("Invite links")).toBeNull();
    // A member is never asked for what only an admin may read.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/invitations"))).toBe(false);
  });

  it("gives an admin the invite button and the invite links", async () => {
    auth.administers = true;
    stubFetch();
    renderPage();

    expect(await screen.findByText("me@example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite users" })).toBeTruthy();
    expect(screen.getByText("Invite links")).toBeTruthy();
    expect(await screen.findByText("No active invite links")).toBeTruthy();
    expect(screen.queryByText(/Ask a workspace admin/)).toBeNull();
  });
});
