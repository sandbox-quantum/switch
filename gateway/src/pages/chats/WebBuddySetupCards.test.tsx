import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatsStore } from "@switch-console/chat-ui/stores/chats-store";
import { withChatHost } from "@switch-console/chat-ui/testing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRequestError } from "./webChatClient";
import { WEB_BUDDY_STAY_MESSAGE, WebBuddySetupCards } from "./WebBuddySetupCards";

vi.mock("../../data/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "me", name: "Ada Lovelace" },
    session: { tenant: { id: "t1" } },
  }),
}));

const api = vi.hoisted(() => ({
  fetchBridges: vi.fn(),
  fetchMyIdentities: vi.fn(),
  fetchRoom: vi.fn(),
}));
vi.mock("../../data/api", () => api);

const client = vi.hoisted(() => ({ createChat: vi.fn() }));
vi.mock("./webChatClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webChatClient")>()),
  webChatsClient: client,
}));

// The dashboard's own dialogs, tested where they live.
vi.mock("../collaborations/RegisterMessagingAppDialog", () => ({
  default: ({ open, initialType }: { open: boolean; initialType: string }) =>
    open ? <div role="dialog">Connect {initialType}</div> : null,
}));
vi.mock("../messaging-apps/LinkAccountDialog", () => ({
  default: ({ open }: { open: { app: { display_name: string } } | null }) =>
    open ? <div role="dialog">Link on {open.app.display_name}</div> : null,
}));

const timeline = { messages: [] as never[], pending: [] as never[], send: vi.fn() };

function slack(status = "active") {
  return {
    bridge_id: "b1",
    bridge_type: "slack",
    display_name: "Acme Slack",
    status,
    directory_search_supported: true,
  };
}

function renderCards() {
  const chats = {
    userId: "me",
    timelines: { get: () => timeline },
    add: vi.fn(),
  } as unknown as ChatsStore;
  return render(
    withChatHost(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <WebBuddySetupCards
            serverId="web"
            roomId="r1"
            agentId="a1"
            agentName="switch-buddy-ada"
          />
        </MemoryRouter>
      </QueryClientProvider>,
      { chats, bridgePlatformLabel: (type) => (type === "slack" ? "Slack" : (type ?? "")) },
    ),
  );
}

beforeEach(() => {
  api.fetchBridges.mockResolvedValue([]);
  api.fetchMyIdentities.mockResolvedValue([]);
  client.createChat.mockRejectedValue(
    new ChatRequestError("http", "No such operation", 404, "NO_SUCH_OPERATION"),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WebBuddySetupCards", () => {
  it("asks where the team chats, and opens the dashboard's connect dialog for the app picked", async () => {
    renderCards();
    expect(await screen.findByText("Where does your team chat?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Slack/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect Slack" }));
    expect(screen.getByRole("dialog").textContent).toBe("Connect slack");
  });

  it("asks to link an account on a connected app, with the dashboard's link dialog", async () => {
    api.fetchBridges.mockResolvedValue([slack()]);
    renderCards();
    fireEvent.click(await screen.findByRole("button", { name: "Link account" }));
    expect(screen.getByRole("dialog").textContent).toBe("Link on Acme Slack");
  });

  it("makes the private channel once the app is connected and the account linked", async () => {
    api.fetchBridges.mockResolvedValue([slack()]);
    api.fetchMyIdentities.mockResolvedValue([{ bridge_id: "b1", external_user_id: "U1" }]);
    renderCards();
    const create = await screen.findByRole("button", { name: /Create channel and continue/ });
    client.createChat.mockResolvedValue({ roomId: "r2", name: "dm" });
    fireEvent.click(create);
    await waitFor(() =>
      expect(client.createChat).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agentIds: ["a1"],
          bridgeId: "b1",
          requestId: "buddy-handoff:a1:b1",
          resumeOnly: false,
        }),
      ),
    );
    const made = client.createChat.mock.lastCall![0] as { greeting: string };
    expect(made.greeting).toContain("Slack is connected");
  });

  it("says in the chat that the person stays here", async () => {
    renderCards();
    fireEvent.click(await screen.findByRole("button", { name: /Connect an app later/ }));
    expect(timeline.send).toHaveBeenCalledWith(
      expect.objectContaining({ body: WEB_BUDDY_STAY_MESSAGE }),
    );
  });
});
