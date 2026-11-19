import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChatSummary } from "@switch-console/chat-ui/contracts/chats";
import type { ChatsStore } from "@switch-console/chat-ui/stores/chats-store";
import { withChatHost } from "@switch-console/chat-ui/testing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomChat } from "./RoomChat";

vi.mock("../../data/AuthContext", () => ({
  useAuth: () => ({ user: { id: "me" }, session: { tenant: { id: "t1" } } }),
}));

const api = vi.hoisted(() => ({
  fetchRoom: vi.fn(),
  loadAgents: vi.fn(),
  addRoomAgents: vi.fn(),
  removeRoomAgent: vi.fn(),
}));
vi.mock("../../data/api", () => api);

const client = vi.hoisted(() => ({
  listChatMembers: vi.fn(),
  removeChatMember: vi.fn(),
  removeChatAgent: vi.fn(),
  addChatAgent: vi.fn(),
  addChatMember: vi.fn(),
  listAgentCandidates: vi.fn(),
  listWorkspaceMembers: vi.fn(),
}));
vi.mock("./webChatClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webChatClient")>()),
  webChatsClient: client,
}));

// The conversation itself is Console's, tested there.
vi.mock("@switch-console/chat-ui/components/chat-panel", () => ({
  ChatPanel: () => <div data-testid="chat-panel" />,
}));

function groupChat(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    roomId: "r1",
    name: "Bug Triage",
    channelType: "group",
    bridgeType: null,
    channelName: null,
    agents: [
      {
        id: "a1",
        name: "triage",
        displayName: "Triage Assistant",
        iconUrl: null,
        provider: null,
        alias: null,
        ownerName: null,
        ownedByViewer: true,
      },
    ],
    canManage: true,
    ownsAgent: true,
    memberUserIds: ["me", "u2"],
    memberCount: 2,
    unreadCount: 0,
    lastMessage: null,
    ...overrides,
  };
}

function renderRoom(chat: ChatSummary) {
  const chats = {
    userId: "me",
    chat: (id: string) => (id === chat.roomId ? chat : undefined),
    refreshSummaries: vi.fn(async () => {}),
    dropAgent: vi.fn(),
  } as unknown as ChatsStore;
  return render(
    withChatHost(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <RoomChat serverId="web" roomId={chat.roomId} />
        </MemoryRouter>
      </QueryClientProvider>,
      { chats },
    ),
  );
}

beforeEach(() => {
  api.loadAgents.mockResolvedValue([
    { id: "a1", name: "triage", display_name: "Triage Assistant", owner_id: "me" },
  ]);
  api.fetchRoom.mockResolvedValue({
    agent_ids: ["a1"],
    agent_statuses: { a1: "live" },
    roles: [],
    connected_user_names: [],
    can_manage: true,
  });
  client.listChatMembers.mockResolvedValue([
    { userId: "me", name: "Admin", isOwner: true },
    { userId: "u2", name: "Ada", isOwner: false },
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RoomChat", () => {
  it("shows the room's name, kind and who is in it beside the chat", async () => {
    renderRoom(groupChat());
    expect(screen.getByRole("heading", { name: "Bug Triage" })).toBeTruthy();
    expect(screen.getByText("Group chat")).toBeTruthy();
    const agents = within(screen.getByRole("region", { name: "Agents" }));
    expect(agents.getByText("Triage Assistant")).toBeTruthy();
    const people = within(screen.getByRole("region", { name: "People" }));
    expect(await people.findByText("Ada")).toBeTruthy();
    expect(people.getByText("owner")).toBeTruthy();
    expect(screen.getByTestId("chat-panel")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Configuration" }).getAttribute("href")).toBe(
      "/rooms/r1",
    );
  });

  it("lets whoever manages a group chat take a person out", async () => {
    client.removeChatMember.mockResolvedValue(undefined);
    renderRoom(groupChat());
    fireEvent.click(await screen.findByRole("button", { name: "Ada in this room" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from room" }));
    await waitFor(() => expect(client.removeChatMember).toHaveBeenCalledWith("r1", "u2"));
  });

  it("lists the people seen in a room on a messaging app", async () => {
    api.fetchRoom.mockResolvedValue({
      agent_ids: ["a1"],
      agent_statuses: {},
      roles: [],
      connected_user_names: ["louis"],
      can_manage: false,
    });
    renderRoom(groupChat({ bridgeType: "slack", channelType: "channel_private" }));
    const people = within(screen.getByRole("region", { name: "People seen here" }));
    expect(await people.findByText("louis")).toBeTruthy();
    expect(client.listChatMembers).not.toHaveBeenCalled();
  });
});
