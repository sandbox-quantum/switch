import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary, Member, RoomSummary, Session } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { capabilitiesOf } from "../../data/capabilities";
import { ALL_OFF } from "../../data/featureFlags";
import OverviewPage from "./OverviewPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

type Role = "member" | "workspace_admin" | "org_admin";

/** Ada, signed in to Acme as `role`. An organization admin holds only a
 * member's row here and administers it through the organization. */
function signedInAs(role: Role) {
  const tenant = {
    id: "t1",
    slug: "acme",
    name: "Acme",
    role: role === "workspace_admin" ? ("admin" as const) : ("member" as const),
    organization_role: role === "org_admin" ? ("org_admin" as const) : ("member" as const),
    organization_id: "o1",
    archived_at: null,
  };
  const session: Session = {
    user: { id: "u1", name: "Ada", email: "ada@example.com", is_operator: false },
    tenant,
    tenants: [tenant],
    state: "ready",
    can_create_workspace: false,
    can_add_workspace: false,
    invite_email_enabled: false,
  };
  vi.mocked(useAuth).mockReturnValue({
    session,
    capabilities: capabilitiesOf(
      session,
      {
        id: "t1",
        slug: "acme",
        name: "Acme",
        role: tenant.role,
        administers: role !== "member",
        can_delete: false,
        can_manage_data_protection: false,
      },
      ALL_OFF,
    ),
  } as unknown as ReturnType<typeof useAuth>);
}

const agent = (id: string, ownerId: string, parentId: string | null = null) =>
  ({ id, name: id, owner_id: ownerId, parent_agent_id: parentId }) as unknown as AgentSummary;

const room = (id: string, viewerIsMember: boolean) =>
  ({ id, name: id, archived: false, viewer_is_member: viewerIsMember }) as unknown as RoomSummary;

const member = (userId: string, viaOrganization = false) =>
  ({ user_id: userId, name: userId, via_organization: viaOrganization }) as unknown as Member;

/** Ada owns two agents (one a sub-agent) of four, and takes part in two
 * rooms of three. The workspace has two members and an org admin who is
 * there only through the organization. */
const WORKSPACE: Record<string, [number, unknown]> = {
  "/agents": [
    200,
    [agent("a1", "u1"), agent("a2", "u1", "a1"), agent("b1", "u2"), agent("b2", "u2")],
  ],
  "/rooms": [200, [room("r1", true), room("r2", true), room("r3", false)]],
  "/tenants/t1/members": [200, [member("u1"), member("u2"), member("u3", true)]],
};

function answer(routes: Record<string, [number, unknown]>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace(/^\/gateway/, "").split("?")[0];
      const [status, body] = routes[path] ?? [404, { detail: `unmocked ${path}` }];
      return new Response(JSON.stringify(body), { status });
    }),
  );
}

function renderPage() {
  render(
    <MemoryRouter>
      <OverviewPage />
    </MemoryRouter>,
  );
}

function card(label: string): HTMLElement {
  return screen.getByRole("link", { name: new RegExp(`^${label}`) });
}

/** Each card's count once every one has loaded. */
async function counts(): Promise<Record<string, string>> {
  await waitFor(() => expect(screen.queryAllByRole("progressbar")).toHaveLength(0));
  return Object.fromEntries(
    ["Agents", "Users", "Rooms"].map((label) => [
      label,
      card(label).querySelector("p")?.textContent ?? "",
    ]),
  );
}

describe("OverviewPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a workspace admin the workspace's totals", async () => {
    signedInAs("workspace_admin");
    answer(WORKSPACE);
    renderPage();
    expect(await counts()).toEqual({ Agents: "4", Users: "3", Rooms: "3" });
    expect(screen.queryByText("Yours")).toBeNull();
  });

  it("shows an organization admin the totals of a workspace they administer through it", async () => {
    signedInAs("org_admin");
    answer(WORKSPACE);
    renderPage();
    expect(await counts()).toEqual({ Agents: "4", Users: "3", Rooms: "3" });
  });

  it("shows a member their own agents and rooms, sub-agents included, and every user", async () => {
    signedInAs("member");
    answer(WORKSPACE);
    renderPage();
    expect(await counts()).toEqual({ Agents: "2", Users: "3", Rooms: "2" });
    expect(within(card("Agents")).getByText("Yours")).toBeTruthy();
    expect(within(card("Rooms")).getByText("Yours")).toBeTruthy();
    expect(within(card("Users")).queryByText("Yours")).toBeNull();
  });

  it("shows a dash and the reason for a count it could not read, never 0", async () => {
    signedInAs("workspace_admin");
    answer({ ...WORKSPACE, "/agents": [500, { detail: "database unavailable" }] });
    renderPage();
    expect(await counts()).toEqual({ Agents: "—", Users: "3", Rooms: "3" });
    expect(
      within(card("Agents")).getByText("Couldn't count agents: database unavailable"),
    ).toBeTruthy();
  });

  it("reads the counts again when the role changes while the page is open", async () => {
    signedInAs("member");
    // A member is not listed the private rooms they take no part in.
    answer({ ...WORKSPACE, "/rooms": [200, [room("r1", true), room("r2", true)]] });
    const page = () => (
      <MemoryRouter>
        <OverviewPage />
      </MemoryRouter>
    );
    const { rerender } = render(page());
    expect(await counts()).toEqual({ Agents: "2", Users: "3", Rooms: "2" });

    signedInAs("workspace_admin");
    answer(WORKSPACE);
    rerender(page());
    await waitFor(async () =>
      expect(await counts()).toEqual({ Agents: "4", Users: "3", Rooms: "3" }),
    );
  });

  it("opens each list from its card, and the graph from the page", async () => {
    signedInAs("member");
    answer(WORKSPACE);
    renderPage();
    await counts();
    expect(card("Agents").getAttribute("href")).toBe("/agents");
    expect(card("Users").getAttribute("href")).toBe("/settings/users");
    expect(card("Rooms").getAttribute("href")).toBe("/rooms");
    expect(screen.getByRole("link", { name: "View graph" }).getAttribute("href")).toBe(
      "/ecosystem",
    );
  });
});
