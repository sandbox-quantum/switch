import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatSummary } from "@switch-console/chat-ui/contracts/chats";
import { ChatsStore } from "@switch-console/chat-ui/stores/chats-store";
import { withChatHost } from "@switch-console/chat-ui/testing";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "../../data/api";
import ChatsPage from "./ChatsPage";
import { ChatRequestError } from "./webChatClient";
import { WEB_SERVER_ID } from "./webServer";

const api = vi.hoisted(() => ({
  fetchAgents: vi.fn(),
  fetchRoom: vi.fn(async () => null),
}));
vi.mock("../../data/api", () => api);
vi.mock("../../data/AuthContext", () => ({ useAuth: () => ({ user: { id: "me" } }) }));

const client = vi.hoisted(() => ({
  listAgentCandidates: vi.fn(),
  createChat: vi.fn(),
}));
vi.mock("./webChatClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webChatClient")>()),
  webChatsClient: client,
}));

// The chat itself is Console's, tested there; here it only has to be the one opened.
vi.mock("@switch-console/chat-ui/components/chat-panel", () => ({
  ChatPanel: ({ roomId }: { roomId: string }) => <div data-testid="chat-panel">{roomId}</div>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function chat(roomId: string, overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    roomId,
    name: roomId,
    channelType: "direct",
    bridgeType: null,
    channelName: null,
    agents: [
      {
        id: "a1",
        name: "notes-helper",
        displayName: "Notes Helper",
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

function storeWith(chats: ChatSummary[]): ChatsStore {
  const store = new ChatsStore(
    {} as ConstructorParameters<typeof ChatsStore>[0],
    {
      onMessage: () => () => {},
      onSummary: () => () => {},
      onRemoved: () => () => {},
      onState: () => () => {},
      onReset: () => () => {},
    },
  );
  store.serverId = WEB_SERVER_ID;
  for (const each of chats) store.add(WEB_SERVER_ID, each);
  return store;
}

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderAt(path: string, store: ChatsStore) {
  return render(
    withChatHost(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/chats" element={<ChatsPage />} />
          <Route path="/chats/:roomId" element={<ChatsPage />} />
        </Routes>
        <Where />
      </MemoryRouter>,
      { chats: store },
    ),
  );
}

describe("ChatsPage", () => {
  it("lists the person's chats, newest first, a direct chat under its agent's name", () => {
    renderAt(
      "/chats",
      storeWith([
        chat("older", { lastMessage: { seq: 1, sentAt: "2026-01-01T00:00:00Z", preview: "hi", senderName: "Ada" } }),
        chat("group", {
          name: "Ship review",
          channelType: "group",
          unreadCount: 2,
          lastMessage: { seq: 3, sentAt: "2026-01-02T00:00:00Z", preview: "done", senderName: "Notes Helper" },
        }),
      ]),
    );
    const rows = screen.getAllByRole("button").filter((each) => each.textContent?.includes(":"));
    expect(rows.map((each) => each.textContent)).toEqual([
      "Ship reviewNotes Helper: done2",
      "Notes HelperAda: hi",
    ]);
    expect(screen.getByText("Pick a chat, or start one with an agent.")).toBeTruthy();
  });

  it("opens a chat from the list", () => {
    renderAt("/chats", storeWith([chat("r1")]));
    fireEvent.click(screen.getByText("Notes Helper"));
    expect(screen.getByTestId("where").textContent).toBe("/chats/r1");
    expect(screen.getByTestId("chat-panel").textContent).toBe("r1");
  });

  it("starts a chat with an agent the person may chat with, and opens it", async () => {
    const agents = [
      { id: "a1", name: "notes-helper", display_name: "Notes Helper", description: "Takes notes" },
      { id: "a2", name: "someone-elses", display_name: null, description: "" },
    ] as AgentSummary[];
    api.fetchAgents.mockResolvedValue(agents);
    client.listAgentCandidates.mockResolvedValue(["a1"]);
    client.createChat.mockResolvedValue(chat("new-room"));
    const store = storeWith([]);
    renderAt("/chats", store);

    fireEvent.click(screen.getByText("New chat"));
    await waitFor(() => expect(screen.getByText("Takes notes")).toBeTruthy());
    expect(screen.queryByText("someone-elses")).toBeNull();
    fireEvent.click(screen.getByText("Takes notes"));

    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/chats/new-room"));
    expect(client.createChat).toHaveBeenCalledWith(
      expect.objectContaining({ agentIds: ["a1"], name: null, greeting: null }),
    );
    expect(store.chat("new-room")).toBeDefined();
  });

  it("offers every agent, the person's own first, on a server that cannot say which they may use", async () => {
    api.fetchAgents.mockResolvedValue([
      { id: "a2", name: "someone-elses", display_name: null, description: "Theirs", owner_id: "u2" },
      { id: "a1", name: "notes-helper", display_name: "Notes Helper", description: "Mine", owner_id: "me" },
    ] as AgentSummary[]);
    client.listAgentCandidates.mockRejectedValue(
      new ChatRequestError("http", "Group chats are not turned on here.", 409, "GROUP_CHATS_OFF"),
    );
    renderAt("/chats", storeWith([]));

    fireEvent.click(screen.getByText("New chat"));
    await waitFor(() => expect(screen.getByText("Mine")).toBeTruthy());
    const offered = screen.getAllByText(/^(Mine|Theirs)$/).map((each) => each.textContent);
    expect(offered).toEqual(["Mine", "Theirs"]);
    expect(screen.queryByText("Group chats are not turned on here.")).toBeNull();
  });
});
