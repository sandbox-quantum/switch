import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrivateChannelRoom } from "../../data/api";
import PrivateChannelRoomsSection, {
  CAUTION_TEXT,
  channelLabel,
  describeResult,
} from "./PrivateChannelRoomsSection";

type Call = { url: string; method: string; body: unknown };

function room(overrides: Partial<PrivateChannelRoom>): PrivateChannelRoom {
  return {
    room_id: "r1",
    name: "ops",
    bridge_id: "b1",
    bridge_name: "Acme Slack",
    bridge_type: "slack",
    channel_type: "channel_private",
    people: 4,
    members_listed: true,
    cautions: [],
    recommended: true,
    ...overrides,
  };
}

const OPS = room({});
const TELEGRAM = room({
  room_id: "r2",
  name: "tg group",
  bridge_name: "Telegram",
  bridge_type: "telegram",
  channel_type: "group",
  members_listed: false,
  cautions: ["members_not_listed"],
  recommended: false,
});

function serve(initial: PrivateChannelRoom[]) {
  let rooms = initial;
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (method === "POST") {
        const ids = (body as { room_ids: string[] }).room_ids;
        rooms = rooms.filter((r) => !ids.includes(r.room_id));
        return new Response(JSON.stringify({ changed: ids, skipped: [] }));
      }
      return new Response(JSON.stringify({ rooms }));
    }),
  );
  return calls;
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

  it("asks nothing until the admin checks", async () => {
    const calls = serve([OPS]);
    show();

    expect(screen.getByRole("button", { name: "Check rooms" })).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("ticks only the rooms that need no second look, and says why the rest don't", async () => {
    serve([TELEGRAM, OPS]);
    show();
    fireEvent.click(screen.getByRole("button", { name: "Check rooms" }));

    const ops = await screen.findByRole("checkbox", { name: "Make ops Private" });
    const tg = screen.getByRole("checkbox", { name: "Make tg group Private" });
    expect((ops as HTMLInputElement).checked).toBe(true);
    expect((tg as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(CAUTION_TEXT.members_not_listed)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make 1 room Private" })).toBeTruthy();
  });

  it("makes exactly the ticked rooms Private after confirming, then checks again", async () => {
    const calls = serve([TELEGRAM, OPS]);
    show();
    fireEvent.click(screen.getByRole("button", { name: "Check rooms" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Make tg group Private" }));
    fireEvent.click(screen.getByRole("button", { name: "Make 2 rooms Private" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Make 2 rooms Private?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Make Private" }));

    await screen.findByText("Made 2 rooms Private.");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("/tenants/t1/private-channel-rooms/make-private");
    expect(new Set((post?.body as { room_ids: string[] }).room_ids)).toEqual(
      new Set(["r1", "r2"]),
    );
    await waitFor(() =>
      expect(screen.getByText(/No Public rooms on private channels/)).toBeTruthy(),
    );
  });

  it("can't be applied with nothing ticked", async () => {
    serve([TELEGRAM]);
    show();
    fireEvent.click(screen.getByRole("button", { name: "Check rooms" }));

    const button = await screen.findByRole("button", { name: "Make 0 rooms Private" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("labels", () => {
  it("names channel types, and an unknown one as needing a check", () => {
    expect(channelLabel("channel_private")).toBe("Private channel");
    expect(channelLabel("direct")).toBe("Direct message");
    expect(channelLabel(null)).toBe("Unknown, check by hand");
  });

  it("says which rooms were skipped and why", () => {
    const names = new Map([["r1", "ops"]]);
    expect(
      describeResult({ changed: [], skipped: [{ room_id: "r1", reason: "archived" }] }, names),
    ).toBe("Made 0 rooms Private. ops was skipped: it was archived.");
  });
});
