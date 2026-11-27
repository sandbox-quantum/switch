import { cleanup, render, screen, within } from "@testing-library/react";
import type { ChatSummary } from "@switch-console/chat-ui/contracts/chats";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWebChats } from "../pages/chats/WebChatHost";
import PageShell from "./PageShell";

const features = vi.hoisted(() => ({ gateway_chats: true }));
vi.mock("../data/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "user-1", name: "Test User", email: "test@example.com" },
    session: {
      user: { id: "user-1", name: "Test User", email: "test@example.com" },
      tenant: { id: "tenant-1", name: "Workspace" },
    },
    isOperator: false,
    capabilities: { features },
    logout: vi.fn(),
    logoutEverywhere: vi.fn(),
    canAdminTenant: false,
    staleError: null,
    workspaceMismatch: null,
    recheck: vi.fn(),
  }),
}));

const listChats = vi.hoisted(() => vi.fn());
vi.mock("../pages/chats/webChatClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pages/chats/webChatClient")>();
  return {
    ...actual,
    webChatsClient: { listChats, listArchivedChats: async () => [] },
  };
});

vi.mock("../data/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/api")>()),
  fetchAvatarSettings: vi.fn().mockResolvedValue({ third_party_avatars_enabled: false }),
}));

function chat(roomId: string, unreadCount: number, bridgeType: string | null = null): ChatSummary {
  return {
    roomId,
    name: roomId,
    channelType: "channel_private",
    bridgeType,
    channelName: null,
    agents: [],
    canManage: false,
    ownsAgent: false,
    memberUserIds: ["user-1"],
    memberCount: 1,
    unreadCount,
    lastMessage: null,
  };
}

/** Stands in for the chats page, which opens the chat feeds while it is shown. */
function OpensChats() {
  const web = useWebChats();
  useEffect(() => {
    web?.start();
    return () => web?.stop();
  }, [web]);
  return <p>chats</p>;
}

function renderShell(at = "/chats") {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route element={<PageShell />}>
          <Route path="/chats" element={<OpensChats />} />
          <Route path="*" element={<p>page</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/** The rail's link named `name`, and whether it shows as the current page. */
async function railLink(name: string) {
  const rail = await screen.findByRole("navigation", { name: "Main" });
  // A badge, such as Chats' unread count, comes before the label in the link's name.
  const link = within(rail).queryByRole("link", { name: new RegExp(`(^|\\s)${name}$`) });
  return link && { href: link.getAttribute("href"), current: link.getAttribute("aria-current") === "page" };
}

describe("NavRail in the page shell", () => {
  beforeEach(() => {
    features.gateway_chats = true;
    // The live feeds stay open and say nothing.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    listChats.mockResolvedValue([chat("r1", 3), chat("r2", 5), chat("slack-room", 7, "slack")]);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("badges Chats with the unread count of the chats it reads", async () => {
    renderShell();
    const badge = await screen.findByLabelText("8 unread");
    expect(badge.textContent).toBe("8");
  });

  it("shows the rail with no badge where the server has no chats in the dashboard", async () => {
    features.gateway_chats = false;
    renderShell();
    await screen.findByText("chats");
    expect(screen.getByRole("complementary")).toBeTruthy();
    expect(screen.queryByLabelText(/unread/)).toBeNull();
    expect(listChats).not.toHaveBeenCalled();
  });

  it("takes Agents to the agents list, lit there and not on Chats", async () => {
    renderShell("/agents");
    expect(await railLink("Agents")).toEqual({ href: "/agents", current: true });
    expect(await railLink("Chats")).toEqual({ href: "/chats", current: false });
    cleanup();

    renderShell("/chats");
    expect(await railLink("Agents")).toEqual({ href: "/agents", current: false });
    expect(await railLink("Chats")).toEqual({ href: "/chats", current: true });
  });

  it("has no Rooms item, and lights Chats on a room's pages", async () => {
    renderShell("/rooms/r1/manage");
    expect(await railLink("Rooms")).toBeNull();
    expect(await railLink("Chats")).toEqual({ href: "/chats", current: true });
  });
});
