import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimablePlatform, InstalledApp } from "../../data/api";
import InstalledAppsSection from "./InstalledAppsSection";

const teamsInstall: InstalledApp = {
  id: "i1",
  platform: "teams",
  external_workspace_id: "org-123",
  status: "active",
  scopes: "ChannelMessage.Send",
  bridge_id: "b1",
  installed_at: "2026-01-01",
  ended_at: null,
  can_disconnect: true,
};

function mockFetch(
  installs: InstalledApp[] = [],
  offered: { platforms: string[]; claimable?: ClaimablePlatform[] } = { platforms: ["teams"] },
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/messaging-apps/installs")) {
        return new Response(JSON.stringify({ installs }), { status: 200 });
      }
      if (String(url).includes("/messaging-apps")) {
        return new Response(JSON.stringify(offered), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

const telegramChat = (overrides: Partial<InstalledApp>): InstalledApp => ({
  ...teamsInstall,
  id: "c1",
  platform: "telegram",
  external_workspace_id: "-1001",
  name: "Ops group",
  can_disconnect: true,
  ...overrides,
});

describe("InstalledAppsSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("names the Microsoft Teams app rather than a bare title-cased 'Teams'", async () => {
    mockFetch();
    render(<InstalledAppsSection onConnectionsChanged={() => {}} memberView={false} />);

    expect(
      await screen.findByRole("button", { name: "Add to Microsoft Teams" }),
    ).toBeTruthy();
  });

  it("shows the platform column's own name, not a bare title-cased key", async () => {
    mockFetch([teamsInstall]);
    render(<InstalledAppsSection onConnectionsChanged={() => {}} memberView={false} />);

    expect(await screen.findByText("org-123")).toBeTruthy();
    // The row's platform chip renders Microsoft's own name, same as the
    // "Add to..." button above it, rather than a title-cased "Teams".
    expect(screen.getByText("Microsoft Teams")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add to Microsoft Teams" }),
    ).toBeTruthy();
  });

  it("shows a member only the chats they can add to or still have connected", async () => {
    mockFetch([telegramChat({ status: "disconnected", ended_at: "2026-02-01" })], {
      platforms: [],
      claimable: [{ platform: "telegram", connected: true, can_add_chat: true }],
    });
    render(<InstalledAppsSection onConnectionsChanged={() => {}} memberView />);

    expect(await screen.findByRole("heading", { name: "Chats" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add to Telegram" })).toBeTruthy();
  });

  it("shows a member nothing for a platform they can neither add to nor have a live chat on", async () => {
    mockFetch([telegramChat({ status: "disconnected", ended_at: "2026-02-01" })], {
      platforms: [],
      claimable: [{ platform: "telegram", connected: false, can_add_chat: false }],
    });
    const { container } = render(<InstalledAppsSection onConnectionsChanged={() => {}} memberView />);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.textContent).toBe("");
  });

  it("points a member at no table they cannot see", async () => {
    mockFetch([], {
      platforms: [],
      claimable: [{ platform: "telegram", connected: true, can_add_chat: true }],
    });
    render(<InstalledAppsSection onConnectionsChanged={() => {}} memberView />);

    expect(await screen.findByText("No chats connected.")).toBeTruthy();
    expect(screen.queryByText(/an admin deletes it above/)).toBeNull();
  });

  it("says the chats could not be loaded instead of showing nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502 })),
    );
    render(<InstalledAppsSection onConnectionsChanged={() => {}} memberView />);

    expect(await screen.findByText(/Could not load your chats/)).toBeTruthy();
  });

  it("keeps a member's live chat on a platform Switch no longer offers, to take it out", async () => {
    mockFetch([telegramChat({ status: "active" })], { platforms: [], claimable: [] });
    render(<InstalledAppsSection onConnectionsChanged={() => {}} memberView />);

    expect(await screen.findByText("Ops group")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });
});
