import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import InstalledAppsSection from "./InstalledAppsSection";

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/messaging-apps/installs")) {
        return new Response(JSON.stringify({ installs: [] }), { status: 200 });
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
});
