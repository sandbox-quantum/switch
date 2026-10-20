import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledApp } from "../../data/api";
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
};

function mockFetch(installs: InstalledApp[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/messaging-apps/installs")) {
        return new Response(JSON.stringify({ installs }), { status: 200 });
      }
      if (String(url).includes("/messaging-apps")) {
        return new Response(JSON.stringify({ platforms: ["teams"] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

describe("InstalledAppsSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("names the Microsoft Teams app rather than a bare title-cased 'Teams'", async () => {
    mockFetch();
    render(<InstalledAppsSection isAdmin onConnectionsChanged={() => {}} />);

    expect(
      await screen.findByRole("button", { name: "Add to Microsoft Teams" }),
    ).toBeTruthy();
  });

  it("shows the platform column's own name, not a bare title-cased key", async () => {
    mockFetch([teamsInstall]);
    render(<InstalledAppsSection isAdmin onConnectionsChanged={() => {}} />);

    expect(await screen.findByText("org-123")).toBeTruthy();
    // The row's platform chip renders Microsoft's own name, same as the
    // "Add to..." button above it, rather than a title-cased "Teams".
    expect(screen.getByText("Microsoft Teams")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add to Microsoft Teams" }),
    ).toBeTruthy();
  });
});
