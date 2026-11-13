import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { directChatsFor } from "@switch-console/chat-ui/components/direct-chats";
import type { ChatSummary } from "@switch-console/chat-ui/contracts/chats";
import { ChatsStore } from "@switch-console/chat-ui/stores/chats-store";
import { withChatHost } from "@switch-console/chat-ui/testing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentListEntry } from "../../data/api";
import ChatsPage from "./ChatsPage";
import type { WebChats } from "./webChats";
import { WEB_SERVER_ID } from "./webServer";

const api = vi.hoisted(() => ({
  loadAgents: vi.fn(),
  fetchAgent: vi.fn(),
  fetchRoom: vi.fn(async () => null),
}));
vi.mock("../../data/api", () => api);
vi.mock("../../data/AuthContext", () => ({ useAuth: () => ({ user: { id: "me" } }) }));

const web = vi.hoisted(() => ({ current: null as WebChats | null }));
vi.mock("./WebChatHost", () => ({ useWebChats: () => web.current }));

// The chat itself is Console's, tested there; here it only has to be the one opened.
vi.mock("@switch-console/chat-ui/components/chat-panel", () => ({
  ChatPanel: ({ roomId }: { roomId: string }) => <div data-testid="chat-panel">{roomId}</div>,
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

function renderAt(path: string, store: ChatsStore) {
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
  } as unknown as WebChats;
  return render(
    withChatHost(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/chats" element={<ChatsPage />} />
            <Route path="/chats/agents/:agentId" element={<ChatsPage />} />
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
    const list = await screen.findByLabelText("Agents");
    await waitFor(() => expect(within(list).getAllByTitle(/./)).toHaveLength(3));
    expect(within(list).getAllByTitle(/./).map((row) => row.getAttribute("title"))).toEqual([
      "shared-helper",
      "notes-helper",
      "researcher",
    ]);
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
});
