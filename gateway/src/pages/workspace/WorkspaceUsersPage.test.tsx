import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceUsersPage from "./WorkspaceUsersPage";

vi.mock("../../components/DataTable", () => import("../../test/FakeDataTable"));

const auth = vi.hoisted(() => ({
  administers: false,
  organizationAdmin: false,
  tenant: { id: "t1", name: "Acme" },
  refresh: async () => {},
}));
vi.mock("../../data/AuthContext", () => ({
  useAuth: () => ({
    session: {
      user: { id: "me", name: "Me", email: "me@example.com", is_operator: false },
      tenant: {
        id: auth.tenant.id,
        slug: auth.tenant.id,
        name: auth.tenant.name,
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
    refresh: () => auth.refresh(),
  }),
}));

function person(userId: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    user_id: userId,
    name,
    email: `${userId}@example.com`,
    role: "member",
    created_at: "2026-01-01",
    service_account: false,
    organization_role: "member",
    via_organization: false,
    can_change_role: false,
    change_role_blocked_reason: null,
    can_remove: false,
    remove_blocked_reason: null,
    can_receive_transfer: true,
    ...overrides,
  };
}

const ROSTER = [person("me", "Me", { can_receive_transfer: false })];

function stubFetch(answer: (url: string, init?: RequestInit) => Promise<Response> | Response | null = () => null) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const answered = await answer(url, init);
    if (answered !== null) return answered;
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
  return render(
    <MemoryRouter>
      <WorkspaceUsersPage />
    </MemoryRouter>,
  );
}

describe("WorkspaceUsersPage", () => {
  beforeEach(() => {
    auth.tenant = { id: "t1", name: "Acme" };
    auth.refresh = async () => {};
  });

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

  it("after leaving, starts again on the next workspace and still says what happened", async () => {
    auth.administers = true;
    let answerNext: (response: Response) => void = () => {};
    const next = new Promise<Response>((resolve) => (answerNext = resolve));
    stubFetch((url, init) => {
      if (url.includes("/tenants/t1/members") && init?.method === "DELETE")
        return new Response(
          JSON.stringify({
            ok: true,
            warning: "Could not revoke the GitHub sign-in.",
            handed_over_to: { user_id: "ann", name: "Ann", email: "ann@example.com" },
            handed_over: { room: 1 },
          }),
        );
      if (url.endsWith("/removal"))
        return new Response(
          JSON.stringify({ handed_over_to: { user_id: "ann", name: "Ann", email: "ann@example.com" } }),
        );
      if (url.endsWith("/agents")) return new Response("[]");
      if (url.includes("/tenants/t1/members"))
        return new Response(
          JSON.stringify([
            person("me", "Me", { role: "admin", can_change_role: true, can_remove: true }),
            person("ann", "Ann", { role: "admin", can_change_role: true, can_remove: true }),
          ]),
        );
      if (url.includes("/tenants/t2/members")) return next;
      return null;
    });
    // The server moved the session to the next workspace.
    auth.refresh = async () => {
      auth.tenant = { id: "t2", name: "Beta" };
    };
    renderPage();
    expect(await screen.findByText("ann@example.com")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Actions for Me" }));
    fireEvent.click(within(screen.getByRole("menu")).getByText("Leave workspace"));
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByText(/passes to Ann/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Leave workspace" }));

    // The old workspace's people are gone while the next one's load, and
    // nothing of the old one is left to act on.
    await waitFor(() => expect(screen.getByText("Everyone in Beta.")).toBeTruthy());
    expect(screen.queryByText("ann@example.com")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
    expect(screen.getByText("You left the workspace. What you owned there passed to Ann (ann@example.com): 1 room.")).toBeTruthy();
    expect(screen.getByText("Could not revoke the GitHub sign-in.")).toBeTruthy();

    await act(async () => answerNext(new Response(JSON.stringify([person("bo", "Bo")]))));
    expect(await screen.findByText("bo@example.com")).toBeTruthy();
    expect(screen.getByText(/You left the workspace/)).toBeTruthy();
  });
});
