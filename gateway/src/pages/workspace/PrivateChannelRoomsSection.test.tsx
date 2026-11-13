import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import PrivateChannelRoomsSection from "./PrivateChannelRoomsSection";

function serve(count: number) {
  const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ count })));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function show() {
  render(
    <MemoryRouter>
      <PrivateChannelRoomsSection tenantId="t1" />
    </MemoryRouter>,
  );
}

describe("PrivateChannelRoomsSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says how many rooms there are and leads to the review page", async () => {
    const fetch = serve(132);
    show();

    await screen.findByText(/132 Public rooms are on private channels/);
    const review = screen.getByRole("link", { name: "Review" });
    expect(review.getAttribute("href")).toBe("/workspace/private-channel-rooms");
    expect(String(fetch.mock.calls[0][0])).toContain("/tenants/t1/private-channel-rooms/count");
  });

  it("shows nothing when there are none", async () => {
    const fetch = serve(0);
    show();

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText(/Public room/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Review" })).toBeNull();
  });
});
