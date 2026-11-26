import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { directChatsFor } from "@switch-console/chat-ui/components/direct-chats";
import type { ChatSummary } from "@switch-console/chat-ui/contracts/chats";
import { ChatsStore } from "@switch-console/chat-ui/stores/chats-store";
import { withChatHost } from "@switch-console/chat-ui/testing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type InitialEntry, MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentListEntry } from "../../data/api";
import { clickOutsideDialog } from "../../test/clickOutsideDialog";
import ChatsPage from "./ChatsPage";
import type { WebChats } from "./webChats";
import { WEB_SERVER_ID } from "./webServer";

const api = vi.hoisted(() => ({
  loadAgents: vi.fn(),
  fetchAgent: vi.fn(),
  fetchAgents: vi.fn(async () => []),
  fetchRoom: vi.fn(async () => null),
  fetchRooms: vi.fn(async () => []),
  loadRooms: vi.fn(),
  loadRoomsWithArchived: vi.fn(async (): Promise<unknown[]> => []),
  fetchRoomGroups: vi.fn(async () => []),
  fetchAllExternalUsers: vi.fn(async () => []),
  fetchBridges: vi.fn(async () => []),
  fetchMyIdentities: vi.fn(async () => []),
  fetchRoomAgentCandidates: vi.fn(async () => ({ agent_ids: null })),
  OWNER_ONLY_POLICY: {
    rules: [
      {
        rooms: "*",
        room_groups: "*",
        users: [],
        agents: [],
        owner: true,
        owner_agents: false,
      },
    ],
  },
}));
vi.mock("../../data/api", () => api);
vi.mock("../../data/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "me" },
    session: { tenant: { id: "t1" } },
    canAdminTenant: false,
    capabilities: { features: {} },
  }),
}));

const client = vi.hoisted(() => ({
  addChatMember: vi.fn(async () => []),
  createChat: vi.fn(),
  listWorkspaceMembers: vi.fn(async () => []),
  listAgentCandidates: vi.fn(async () => ["a1", "a2"]),
  listChatMembers: vi.fn(async () => []),
}));
vi.mock("./webChatClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webChatClient")>()),
  webChatsClient: client,
}));

const web = vi.hoisted(() => ({ current: null as WebChats | null }));
vi.mock("./WebChatHost", () => ({
  useWebChats: () => web.current,
  WEB_PARTICIPANT_MARKS: {
    AgentAvatar: ({ name }: { name: string }) => <span>{name[0]}</span>,
    useAgentAccent: () => null,
  },
  useWebBridgeIcons: () => ({ BridgeIcon: () => null, hasBridgeIcon: () => false }),
}));

// The chat itself is Console's, tested there; here it only has to be the one opened.
vi.mock("@switch-console/chat-ui/components/chat-panel", () => ({
  ChatPanel: ({ roomId }: { roomId: string }) => <div data-testid="chat-panel">{roomId}</div>,
  useAgentActivities: () => [],
}));

vi.mock("./AgentSettingsView", () => ({
  AgentSettingsView: () => <div data-testid="agent-settings">Agent Settings</div>,
  AgentConnectorsView: () => <div data-testid="agent-connectors">Agent Connectors</div>,
}));

const create = vi.fn();

function agent(id: string, name: string, owner: string): AgentListEntry {
  return {
    id,
    name,
    display_name: null,
    icon_url: null,
    description: "",
    owner_id: owner,
    owner_name: owner === "me" ? "Ada" : "Bob",
    status: "online",
    device: null,
  } as unknown as AgentListEntry;
}

function chat(roomId: string, agentId: string, overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    roomId,
    name: roomId,
    channelType: "direct",
    bridgeType: null,
    channelName: null,
    agents: [
      {
        id: agentId,
        name: agentId,
        displayName: null,
        iconUrl: null,
        provider: null,
        alias: null,
        ownerName: null,
        ownedByViewer: true,
      },
    ],
    canManage: true,
    ownsAgent: true,
    memberUserIds: ["me"],
    memberCount: 1,
    unreadCount: 0,
    lastMessage: null,
    ...overrides,
  };
}

function room(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name,
    archived: false,
    viewer_is_member: true,
    is_console_chat: false,
    channel_type: "channel_private",
    bridge_type: null,
    bridge_display_name: null,
    created_at: "2026-01-01T00:00:00Z",
    last_message_at: null,
    ...overrides,
  };
}

const sent = (seq: number, day: string) => ({
  seq,
  sentAt: `2026-01-${day}T00:00:00Z`,
  preview: "hi",
  senderName: "Ada",
});

function storeWith(chats: ChatSummary[]): ChatsStore {
  const store = new ChatsStore(
    { timeline: () => ({}) } as unknown as ConstructorParameters<typeof ChatsStore>[0],
    {
      onMessage: () => () => {},
      onSummary: () => () => {},
      onRemoved: () => () => {},
      onState: () => () => {},
      onReset: () => () => {},
    },
  );
  store.serverId = WEB_SERVER_ID;
  store.userId = "me";
  for (const each of chats) store.add(WEB_SERVER_ID, each);
  return store;
}

function Where() {
  const location = useLocation();
  return <span data-testid="where">{location.pathname + location.search}</span>;
}

function renderAt(path: InitialEntry, store: ChatsStore) {
  const directChats = directChatsFor({
    chats: store,
    create,
    scope: () => ({ serverId: WEB_SERVER_ID, userId: "me", workspaceId: "t1" }),
    storage: localStorage,
    newId: () => "new-1",
    moved: () => {},
  });
  web.current = {
    chats: store,
    directChats,
    onChatMade: () => () => {},
    start: () => {},
    stop: () => {},
  } as unknown as WebChats;
  return render(
    withChatHost(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/chats" element={<ChatsPage />} />
            <Route path="/chats/agents/:agentId" element={<ChatsPage />} />
            <Route path="/chats/rooms/:roomId" element={<ChatsPage />} />
            <Route path="/chats/:roomId" element={<ChatsPage />} />
          </Routes>
          <Where />
        </MemoryRouter>
      </QueryClientProvider>,
      { chats: store, unsavedChat: (roomId) => directChats.unsavedChat(roomId) },
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  api.loadAgents.mockResolvedValue([
    agent("a1", "notes-helper", "me"),
    agent("a2", "researcher", "me"),
    agent("a3", "someone-elses", "u2"),
    agent("a4", "shared-helper", "u2"),
  ]);
  api.loadRooms.mockResolvedValue([
    room("ops", "Ops room", { last_message_at: "2026-01-03T00:00:00Z", bridge_type: "slack" }),
    room("old", "Old room", { last_message_at: "2026-01-01T00:00:00Z" }),
    room("theirs", "Not mine", { viewer_is_member: false }),
    room("c1", "c1", { is_console_chat: true, channel_type: "direct" }),
  ]);
  api.fetchAgent.mockResolvedValue({
    rooms: [
      { room_id: "ops", room_name: "Ops room", archived: false, status: "live", room_role: null },
    ],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChatsPage", () => {
  it("lists the person's agents and those they chat with, newest direct chat first", async () => {
    renderAt(
      "/chats",
      storeWith([
        chat("c-old", "a1", { lastMessage: sent(1, "01") }),
        chat("c-new", "a4", { lastMessage: sent(2, "02"), unreadCount: 3 }),
      ]),
    );
    const list = await screen.findByLabelText("Your agents");
    await waitFor(() => expect(within(list).getAllByTitle(/./)).toHaveLength(3));
    expect(
      within(list)
        .getAllByTitle(/./)
        .map((row) => row.getAttribute("title")),
    ).toEqual(["shared-helper", "notes-helper", "researcher"]);
    expect(within(list).getByLabelText("3 unread")).toBeTruthy();
    expect(screen.getByText("Pick an agent to chat with.")).toBeTruthy();
  });

  it("shows an agent's direct chats and rooms, with its newest chat open", async () => {
    renderAt(
      "/chats/agents/a1",
      storeWith([
        chat("c1", "a1", { name: "Monday", lastMessage: sent(1, "01") }),
        chat("c2", "a1", { name: "Tuesday", lastMessage: sent(2, "02") }),
      ]),
    );
    await waitFor(() => expect(screen.getByText("Ops room")).toBeTruthy());
    expect(screen.getByRole("heading", { name: "notes-helper" })).toBeTruthy();
    expect(screen.getByText("Your agent")).toBeTruthy();
    expect(screen.getByTestId("chat-panel").textContent).toBe("c2");

    fireEvent.click(screen.getByLabelText("Open chat Monday"));
    expect(screen.getByTestId("where").textContent).toBe("/chats/agents/a1?chat=c1");
    expect(screen.getByTestId("chat-panel").textContent).toBe("c1");
  });

  it("says a room the person is not in is not one of their chats", async () => {
    renderAt("/chats/agents/a1", storeWith([chat("c1", "a1")]));
    fireEvent.click(await screen.findByText("Ops room"));
    expect(screen.getByText("This room isn't one of your chats")).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toBe("/chats/agents/a1?room=ops");
  });

  it("starts an agent with no direct chat on an unsaved one, made only on its first message", async () => {
    renderAt("/chats/agents/a2", storeWith([]));
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe(
        "/chats/agents/a2?chat=unsaved-chat%3Anew-1",
      ),
    );
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getByTestId("chat-panel").textContent).toBe("unsaved-chat:new-1");
    expect(create).not.toHaveBeenCalled();
  });

  it("opens a chat linked by its room on its agent's page", async () => {
    renderAt("/chats/c1", storeWith([chat("c1", "a1")]));
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/chats/agents/a1?chat=c1"),
    );
  });

  it("lists the person's rooms and group chats on no messaging app under Rooms, newest first", async () => {
    renderAt(
      "/chats",
      storeWith([
        chat("c1", "a1"),
        chat("team", "a2", {
          name: "Team chat",
          channelType: "group",
          lastMessage: sent(5, "05"),
        }),
        chat("standup", "a2", { name: "Slack standup", channelType: "group", bridgeType: "slack" }),
      ]),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Rooms" }));
    const list = await screen.findByLabelText("Your rooms");
    await waitFor(() => expect(within(list).getByText("Old room")).toBeTruthy());
    expect(
      within(list)
        .getAllByRole("generic", { hidden: true })
        .filter((each) => each.getAttribute("title") !== null)
        .map((each) => each.getAttribute("title")),
    ).toEqual(["Team chat", "Old room"]);
    expect(within(list).queryByRole("button", { name: "Slack" })).toBeNull();
    expect(screen.getByText("New Room")).toBeTruthy();
  });

  it("leads from a banner above New Room to Messaging apps in settings", async () => {
    renderAt("/chats?tab=rooms", storeWith([]));
    const list = await screen.findByLabelText("Your rooms");
    const buttons = within(list).getAllByRole("button");
    const banner = within(list).getByRole("button", { name: "Connect a messaging app" });
    expect(buttons.indexOf(banner)).toBe(0);
    expect(buttons[1].textContent).toBe("New Room");
    fireEvent.click(banner);
    expect(screen.getByTestId("where").textContent).toBe("/settings/messaging-apps");
  });

  it("opens a room on a messaging app from its link, though the Rooms list leaves it out", async () => {
    renderAt(
      "/chats/rooms/ops",
      storeWith([chat("ops", "a2", { name: "Ops room", channelType: "group", bridgeType: "slack" })]),
    );
    await waitFor(() => expect(screen.getByTestId("chat-panel").textContent).toBe("ops"));
    const list = await screen.findByLabelText("Your rooms");
    await waitFor(() => expect(within(list).getByText("Old room")).toBeTruthy());
    expect(within(list).queryByText("Ops room")).toBeNull();
  });

  it("folds the person's archived rooms on no messaging app under the Rooms list, each opening on its page", async () => {
    api.loadRoomsWithArchived.mockResolvedValue([
      room("ops", "Ops room"),
      room("gone", "Retired room", { archived: true }),
      room("theirs-gone", "Not mine either", { archived: true, viewer_is_member: false }),
      room("slack-gone", "Retired Slack room", { archived: true, bridge_type: "slack" }),
    ]);
    renderAt("/chats?tab=rooms", storeWith([]));
    const list = await screen.findByLabelText("Your rooms");
    const fold = await within(list).findByRole("button", { name: "Archived (1)" });
    expect(within(list).queryByText("Retired room")).toBeNull();
    fireEvent.click(fold);
    expect(within(list).queryByText("Not mine either")).toBeNull();
    expect(within(list).queryByText("Retired Slack room")).toBeNull();
    fireEvent.click(within(list).getByText("Retired room"));
    expect(screen.getByTestId("where").textContent).toBe("/rooms/gone/manage");
  });

  it("opens a room that is one of the person's chats beside the Rooms list", async () => {
    renderAt(
      "/chats/rooms/team",
      storeWith([chat("team", "a2", { name: "Team chat", channelType: "group" })]),
    );
    await waitFor(() => expect(screen.getByTestId("chat-panel").textContent).toBe("team"));
    expect(screen.getByRole("button", { name: "Rooms" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("lets whoever manages a room on no messaging app join its conversation", async () => {
    api.fetchRoom.mockResolvedValue({
      name: "Launch planning",
      can_manage: true,
      bridge_id: null,
    } as never);
    const store = storeWith([]);
    const refresh = vi.spyOn(store, "refreshSummaries").mockResolvedValue();
    renderAt("/chats/rooms/launch", store);
    fireEvent.click(await screen.findByRole("button", { name: "Join the conversation" }));
    await waitFor(() => expect(client.addChatMember).toHaveBeenCalledWith("launch", "me"));
    expect(refresh).toHaveBeenCalled();
  });

  it("points a room on a messaging app at its channel there", async () => {
    api.fetchRoom.mockResolvedValue({
      name: "Sprint Room",
      can_manage: true,
      bridge_id: "b1",
      bridge_type: "mattermost",
      external_channel_url: "https://chat.example/acme/channels/sprint",
    } as never);
    renderAt("/chats/rooms/sprint", storeWith([]));
    expect(await screen.findByText(/conversation is on/)).toBeTruthy();
    const open = screen.getByRole("link", { name: /^Open in/ });
    expect(open.getAttribute("href")).toBe("https://chat.example/acme/channels/sprint");
  });

  it("offers no join for a room on a messaging app", async () => {
    api.fetchRoom.mockResolvedValue({
      name: "Town Square",
      can_manage: true,
      bridge_id: "b1",
    } as never);
    renderAt("/chats/rooms/town", storeWith([]));
    await screen.findByText("Town Square");
    expect(screen.queryByRole("button", { name: "Join the conversation" })).toBeNull();
  });

  it("redirects /chats/agents to /chats", async () => {
    api.loadAgents.mockResolvedValue([agent("a1", "A1", "me")]);
    renderAt("/chats/agents", storeWith([]));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/chats"));
  });

  it("redirects /chats/rooms to /chats", async () => {
    api.loadAgents.mockResolvedValue([agent("a1", "A1", "me")]);
    renderAt("/chats/rooms", storeWith([]));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/chats"));
  });

  it("shows chat panel for a chat with an agent not in the loaded list", async () => {
    api.loadAgents.mockResolvedValue([agent("a1", "A1", "me")]);
    renderAt("/chats/room1", storeWith([chat("room1", "a2")]));
    expect(await screen.findByTestId("chat-panel")).toBeTruthy();
    expect(screen.getByTestId("chat-panel").textContent).toBe("room1");
  });

  it("shows status dots for agents with different statuses", async () => {
    const onlineAgent = { ...agent("a1", "online-agent", "me"), status: "online" as const };
    const offlineAgent = { ...agent("a2", "offline-agent", "me"), status: "offline" as const };
    const notTrackedAgent = { ...agent("a3", "not-tracked-agent", "me"), status: "not_tracked" as const };
    api.loadAgents.mockResolvedValue([onlineAgent, offlineAgent, notTrackedAgent]);
    renderAt("/chats", storeWith([]));
    const list = await screen.findByLabelText("Your agents");
    expect(within(list).getByLabelText("Online")).toBeTruthy();
    expect(within(list).getByLabelText("Offline")).toBeTruthy();
    expect(within(list).getByLabelText("Not tracked")).toBeTruthy();
  });

  it("deep link to settings section does not auto-start a chat", async () => {
    const a1 = agent("a1", "Agent One", "me");
    api.loadAgents.mockResolvedValue([a1]);
    api.fetchAgent.mockResolvedValue({
      ...a1,
      addressing_policy: api.OWNER_ONLY_POLICY,
      mid_turn_delivery: "queue",
      known_agent_type: null,
      description: "",
      can_manage: true,
      can_widen_addressing: true,
      can_change_manage_agents: true,
      can_grant_services: true,
      can_rename: true,
      can_edit_options: false,
      can_transfer: false,
      transfer_blocked_reason: null,
      manager: null,
      service_connections: [],
      sessions: [],
      rooms: [],
      tools: [],
      models: [],
      children: [],
    });
    renderAt("/chats/agents/a1?section=settings", storeWith([]));
    await screen.findByRole("toolbar", { name: "Agent" });
    await screen.findByTestId("agent-settings");
    const where = screen.getByTestId("where").textContent;
    expect(where).not.toContain("unsaved-chat");
    expect(where).toContain("section=settings");
  });

  describe("management of the agent on its page", () => {
    // `body` is what the person's managed agents list answers. Asking for the
    // one agent is answered as Switch answers it for an agent it does not run.
    function managementAnswers(status: number, body: unknown, hosted = { available: false, machines: [] }) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          url === "/gateway/management/agents"
            ? new Response(JSON.stringify(body), { status })
            : url === "/gateway/management/agents/a1"
              ? new Response(JSON.stringify({ error: { code: "not_found", message: "Managed agent not found" } }), {
                  status: 404,
                })
              : url === "/gateway/hosted-machines"
                ? new Response(JSON.stringify(hosted), { status: 200 })
                : new Response("[]", { status: 200 }),
        ),
      );
    }

    const managedA1 = {
      agent_id: "a1",
      name: "notes-helper",
      controller_id: "m1",
      controller_name: "Laptop",
      desired_state: "running",
      definition: { provider: "claude", directory: null },
    };

    afterEach(() => vi.unstubAllGlobals());

    it("asks for no management of an agent Switch does not run, and shows no error or actions", async () => {
      managementAnswers(200, [{ ...managedA1, agent_id: "other" }]);
      renderAt("/chats/agents/a1", storeWith([chat("c1", "a1")]));
      await screen.findByRole("toolbar", { name: "Agent" });
      await waitFor(() => expect(fetch).toHaveBeenCalledWith("/gateway/management/agents", expect.anything()));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetch).not.toHaveBeenCalledWith("/gateway/management/agents/a1", expect.anything());
      expect(screen.queryByText(/Could not read agent management status/)).toBeNull();
      expect(screen.queryByRole("button", { name: /Turn (on|off) agent/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "Move to another device…" })).toBeNull();
    });

    it("says so when the management status cannot be read", async () => {
      managementAnswers(503, {
        error: { code: "unavailable", message: "Switch is restarting.", retryable: true },
      });
      renderAt("/chats/agents/a1", storeWith([chat("c1", "a1")]));
      expect(
        await screen.findByText("Could not read agent management status: Switch is restarting."),
      ).toBeTruthy();
    });

    it("offers turning the agent on or off and moving it when Switch runs it", async () => {
      managementAnswers(200, [managedA1]);
      renderAt("/chats/agents/a1", storeWith([chat("c1", "a1")]));
      expect(await screen.findByRole("button", { name: "Turn off agent" })).toBeTruthy();
      expect(await screen.findByRole("button", { name: "Move to another device…" })).toBeTruthy();
      expect(fetch).toHaveBeenCalledWith("/gateway/management/agents", expect.anything());
      expect(screen.queryByText(/Could not read agent management status/)).toBeNull();
    });

    it("offers no move where Switch runs agents on Switch Cloud, as New agent does", async () => {
      managementAnswers(200, [{ ...managedA1, controller_name: "Switch Cloud" }], { available: true, machines: [] });
      renderAt("/chats/agents/a1", storeWith([chat("c1", "a1")]));
      expect(await screen.findByRole("button", { name: "Turn off agent" })).toBeTruthy();
      await waitFor(() => expect(fetch).toHaveBeenCalledWith("/gateway/hosted-machines", expect.anything()));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByRole("button", { name: "Move to another device…" })).toBeNull();
    });
  });
});

describe("the New room dialog", () => {
  // The room it opens is read like any other; this one has nothing in it yet.
  beforeEach(() => api.fetchRoom.mockResolvedValue(null));
  afterEach(() => vi.restoreAllMocks());

  const made = (roomId: string, agentId: string) =>
    chat(roomId, agentId, { name: "design-review", channelType: "group" });

  async function createIn(dialog: HTMLElement, name: string) {
    fireEvent.change(within(dialog).getByPlaceholderText("Name this room"), {
      target: { value: name },
    });
    const create = within(dialog).getByRole("button", { name: "Create room" });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(create);
  }

  it("opens from the Rooms list in place, and opens the room it makes in Chats", async () => {
    client.createChat.mockResolvedValue(made("r-new", "a2"));
    renderAt("/chats?tab=rooms", storeWith([]));
    fireEvent.click(await screen.findByText("New Room"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("New room")).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toBe("/chats?tab=rooms");

    const participants = within(dialog).getByRole("combobox", { name: "Add agents or people" });
    fireEvent.focus(participants);
    fireEvent.change(participants, { target: { value: "research" } });
    fireEvent.click(await within(dialog).findByRole("option", { name: /researcher/ }));
    await createIn(dialog, "design-review");

    await waitFor(() =>
      expect(client.createChat).toHaveBeenCalledWith(
        expect.objectContaining({ name: "design-review", agentIds: ["a2"], kind: "group" }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/chats/rooms/r-new"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens from an agent's page with that agent already picked", async () => {
    client.createChat.mockResolvedValue(made("r-agent", "a1"));
    renderAt("/chats/agents/a1", storeWith([chat("c1", "a1")]));
    fireEvent.click(await screen.findByRole("button", { name: "New room" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("button", { name: "Remove notes-helper" });
    await createIn(dialog, "with-notes");

    await waitFor(() =>
      expect(client.createChat).toHaveBeenCalledWith(
        expect.objectContaining({ name: "with-notes", agentIds: ["a1"] }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/chats/rooms/r-agent"),
    );
  });

  it("makes a room on a messaging app through the dashboard's rooms route, private by default", async () => {
    api.fetchBridges.mockResolvedValue([
      {
        bridge_id: "b1",
        bridge_type: "slack",
        display_name: "Acme Slack",
        status: "active",
        channel_creation_supported: true,
        channel_creation_enabled: true,
        channel_ids_refused: null,
      },
    ] as never);
    api.fetchMyIdentities.mockResolvedValue([
      { bridge_id: "b1", external_user_id: "U1", external_username: "ada", verified: true },
    ] as never);
    const calls: { path: string; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = String(input);
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      const answer = path.endsWith("/rooms") ? { id: "r-slack" } : [];
      return new Response(JSON.stringify(answer), { status: 200 });
    });
    renderAt("/chats?tab=rooms", storeWith([]));
    fireEvent.click(await screen.findByText("New Room"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Messaging app: Switch" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Acme Slack" }));
    await within(dialog).findByRole("radiogroup", { name: "Channel in Acme Slack" });
    expect(within(dialog).getByText("Switch can’t move a room to another channel later.")).toBeTruthy();
    await createIn(dialog, "launch");

    await waitFor(() =>
      expect(calls.find((call) => call.path === "/gateway/rooms")?.body).toEqual({
        name: "launch",
        description: "",
        instructions: null,
        bridge_id: "b1",
        channel_type: "channel_private",
        read_visibility: "private",
        write_visibility: "private",
        agent_ids: [],
      }),
    );
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/chats/rooms/r-slack"));
  });

  it("keeps what a deleted room's page left to say, until it is dismissed", async () => {
    const notice = "The room was deleted, but its Slack channel could not be archived. Archive it in Slack by hand.";
    renderAt({ pathname: "/chats", search: "?tab=rooms", state: { notice } }, storeWith([]));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(notice);
    fireEvent.click(within(alert).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText(notice)).toBeNull());
  });

  async function openNewRoom() {
    renderAt("/chats?tab=rooms", storeWith([]));
    fireEvent.click(await screen.findByText("New Room"));
    return screen.findByRole("dialog");
  }

  it("closes on a click outside it", async () => {
    await openNewRoom();
    clickOutsideDialog();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes on Escape", async () => {
    const dialog = await openNewRoom();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("stays open to a click outside or Escape while the room is being made", async () => {
    client.createChat.mockReturnValue(new Promise(() => {}));
    const dialog = await openNewRoom();
    await createIn(dialog, "pending");
    await waitFor(() => expect(client.createChat).toHaveBeenCalled());
    clickOutsideDialog();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("opens where the old New room page now leads, and leaves no trace of it in the address", async () => {
    renderAt("/chats?tab=rooms&new=room", storeWith([]));
    expect(within(await screen.findByRole("dialog")).getByText("New room")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/chats?tab=rooms"));
  });
});
