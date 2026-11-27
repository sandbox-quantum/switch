import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChatSummary } from "@switch-console/chat-ui/contracts/chats";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary, Member, RoomSummary, Session } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { capabilitiesOf } from "../../data/capabilities";
import {
  AGENT_MANAGEMENT,
  ALL_OFF,
  type FeatureFlags,
  GATEWAY_CHATS,
  GATEWAY_ONBOARDING,
} from "../../data/featureFlags";
import WebChatHost from "../chats/WebChatHost";
import OverviewPage from "./OverviewPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

const chatsClient = vi.hoisted(() => ({
  listChats: vi.fn(async () => []),
  listArchivedChats: vi.fn(async () => []),
  createChat: vi.fn(),
  sendChatMessage: vi.fn(),
}));
vi.mock("../chats/webChatClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chats/webChatClient")>()),
  webChatsClient: chatsClient,
}));

type Role = "member" | "workspace_admin" | "org_admin";

/** Ada, signed in to Acme as `role`. An organization admin holds only a
 * member's row here and administers it through the organization. */
function signedInAs(role: Role, flags: FeatureFlags = ALL_OFF) {
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
    can_manage_connector_apps: false,
  };
  vi.mocked(useAuth).mockReturnValue({
    session,
    user: session.user,
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
      flags,
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

  it("is titled Home", async () => {
    signedInAs("member");
    answer(WORKSPACE);
    renderPage();
    expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
    await counts();
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

  it.each([
    ["Chats' Rooms tab where there are Chats", true, "/chats?tab=rooms"],
    ["the Rooms page where there are none", false, "/rooms"],
  ])("opens each list from its card, rooms in %s, and the graph from the page", async (_, chats, rooms) => {
    signedInAs("member", { ...ALL_OFF, [GATEWAY_CHATS]: chats });
    answer(WORKSPACE);
    renderPage();
    await counts();
    expect(card("Agents").getAttribute("href")).toBe("/agents");
    expect(card("Users").getAttribute("href")).toBe("/settings/users");
    expect(card("Rooms").getAttribute("href")).toBe(rooms);
    expect(screen.getByRole("link", { name: "View graph" }).getAttribute("href")).toBe(
      "/ecosystem",
    );
  });

  describe("while getting started is unfinished", () => {
    const onboarding = { ...ALL_OFF, [GATEWAY_ONBOARDING]: true, [AGENT_MANAGEMENT]: true };
    const withoutAgentsOfAda = {
      ...WORKSPACE,
      "/agents": [200, [agent("b1", "u2")]] as [number, unknown],
    };

    it("leads back to Get started while the person has no agent of their own", async () => {
      signedInAs("member", onboarding);
      answer(withoutAgentsOfAda);
      renderPage();
      const link = await screen.findByRole("link", { name: "Get started" });
      expect(link.getAttribute("href")).toBe("/get-started");
    });

    it("leaves it out once they have one", async () => {
      signedInAs("member", onboarding);
      answer(WORKSPACE);
      renderPage();
      await counts();
      expect(screen.queryByRole("link", { name: "Get started" })).toBeNull();
    });

    it("leaves it out where getting started on the web is off", async () => {
      signedInAs("member");
      answer(withoutAgentsOfAda);
      renderPage();
      await counts();
      expect(screen.queryByRole("link", { name: "Get started" })).toBeNull();
    });
  });
});

describe("OverviewPage where the dashboard has chats", () => {
  const withChats = { ...ALL_OFF, [GATEWAY_CHATS]: true, [AGENT_MANAGEMENT]: true, [GATEWAY_ONBOARDING]: true };
  const buddy = { agent_id: "buddy1", name: "switch-buddy-ada", template: null };
  let fetched: string[] = [];

  /** The workspace's lists as `routes` answers them; the live chat feeds stay open. */
  function serve(routes: Record<string, unknown>) {
    fetched = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input).replace(/^\/gateway/, "").split("?")[0];
        fetched.push(path);
        if (path.endsWith("/events")) return new Promise<Response>(() => {});
        if (!(path in routes)) return new Response(JSON.stringify({ detail: `unmocked ${path}` }), { status: 404 });
        return new Response(JSON.stringify(routes[path]), { status: 200 });
      }),
    );
  }

  function Where() {
    const location = useLocation();
    return <p data-testid="where">{location.pathname + location.search}</p>;
  }

  function renderHome() {
    render(
      <MemoryRouter initialEntries={["/overview"]}>
        <WebChatHost>
          <Routes>
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </WebChatHost>
      </MemoryRouter>,
    );
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("asks switch-buddy, opening a new chat with it that holds the message, with the chat feeds running", async () => {
    signedInAs("member", withChats);
    serve({ "/management/agents": [buddy], "/agents": [], "/rooms": [], "/collaborations": [] });
    const made = { roomId: "room-new", name: "New Chat", channelType: "direct", agents: [{ id: "buddy1" }] };
    chatsClient.createChat.mockResolvedValue(made as unknown as ChatSummary);
    chatsClient.sendChatMessage.mockReturnValue(new Promise(() => {}));
    renderHome();

    const box = await screen.findByRole("textbox", { name: "Ask switch-buddy anything" });
    expect(screen.getByRole("heading", { name: "Let’s work together" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create my first agent" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "View graph" })).toBeNull();
    expect(fetched).toContain("/chats/events");

    fireEvent.change(box, { target: { value: "Set up a room for my team" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/chats/agents/buddy1?chat=room-new"),
    );
    expect(chatsClient.createChat).toHaveBeenCalledWith(
      expect.objectContaining({ agentIds: ["buddy1"], name: null, greeting: null }),
    );
    expect(chatsClient.sendChatMessage).toHaveBeenCalledWith(
      "room-new",
      expect.objectContaining({ body: "Set up a room for my team" }),
    );
  });

  it("keeps the message and says why when the chat cannot be made", async () => {
    signedInAs("member", withChats);
    serve({ "/management/agents": [buddy], "/agents": [], "/rooms": [], "/collaborations": [] });
    chatsClient.createChat.mockRejectedValue(new Error("Switch is down."));
    renderHome();

    const box = (await screen.findByRole("textbox", { name: "Ask switch-buddy anything" })) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Hello" } });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(await screen.findByText(/Could not open the chat with switch-buddy/)).toBeTruthy();
    expect(box.value).toBe("Hello");
    expect(chatsClient.sendChatMessage).not.toHaveBeenCalled();
  });

  it("leads to Get started while the person has no switch-buddy", async () => {
    signedInAs("member", withChats);
    serve({ "/management/agents": [] });
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: "Connect to AI" }));

    expect(screen.getByTestId("where").textContent).toBe("/get-started");
  });

  it("offers no way to set one up where getting started on the web is off", async () => {
    signedInAs("member", { ...withChats, [GATEWAY_ONBOARDING]: false });
    serve({ "/management/agents": [] });
    renderHome();

    const connect = (await screen.findByRole("button", { name: "Connect to AI" })) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
  });
});
