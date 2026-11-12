import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivateChannelRoom } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import PrivateChannelRoomsPage, {
  CAUTION_TEXT,
  channelLabel,
  confirmText,
  describeAsk,
  describeResult,
} from "./PrivateChannelRoomsPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

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
const FINANCE = room({ room_id: "r3", name: "finance" });
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
const OLD = room({
  room_id: "r4",
  name: "old board",
  channel_type: null,
  cautions: ["channel_type_not_recorded"],
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
      if (url.includes("/ask-platform")) {
        rooms = rooms.map((r) =>
          r.channel_type === null
            ? { ...r, channel_type: "channel_private", cautions: [], recommended: true }
            : r,
        );
        return new Response(
          JSON.stringify({
            answered: [{ room_id: "r4", channel_type: "channel_private" }],
            unanswered: [],
            stopped: null,
            remaining: 0,
          }),
        );
      }
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
      <PrivateChannelRoomsPage />
    </MemoryRouter>,
  );
}

function box(name: string): HTMLInputElement {
  return screen.getByRole("checkbox", { name: `Make ${name} Private` }) as HTMLInputElement;
}

describe("PrivateChannelRoomsPage", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      session: { tenant: { id: "t1" } },
    } as unknown as ReturnType<typeof useAuth>);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("ticks only the ready rooms, and says why the rest need a check", async () => {
    serve([TELEGRAM, OPS, FINANCE]);
    show();

    await screen.findByRole("checkbox", { name: "Make ops Private" });
    expect(box("ops").checked).toBe(true);
    expect(box("finance").checked).toBe(true);
    expect(box("tg group").checked).toBe(false);
    expect(screen.getByText(CAUTION_TEXT.members_not_listed)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make 2 rooms Private" })).toBeTruthy();
  });

  it("filters and searches", async () => {
    serve([TELEGRAM, OPS, FINANCE]);
    show();
    await screen.findByRole("checkbox", { name: "Make ops Private" });

    fireEvent.click(screen.getByRole("button", { name: "Needs a check (1)" }));
    expect(screen.queryByRole("checkbox", { name: "Make ops Private" })).toBeNull();
    expect(box("tg group")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "All (3)" }));
    fireEvent.change(screen.getByLabelText("Search rooms"), { target: { value: "fin" } });
    expect(box("finance")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Make ops Private" })).toBeNull();
  });

  it("makes exactly the ticked rooms Private after confirming", async () => {
    const calls = serve([TELEGRAM, OPS, FINANCE]);
    show();
    await screen.findByRole("checkbox", { name: "Make ops Private" });
    fireEvent.click(box("finance"));
    fireEvent.click(screen.getByRole("button", { name: "Make 1 room Private" }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Make Private" }));

    await screen.findByText("Made 1 room Private.");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("/tenants/t1/private-channel-rooms/make-private");
    expect((post?.body as { room_ids: string[] }).room_ids).toEqual(["r1"]);
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Make ops Private" })).toBeNull(),
    );
  });

  it("asks the apps about rooms of unrecorded type only when told to", async () => {
    const calls = serve([OLD, OPS]);
    show();
    await screen.findByRole("checkbox", { name: "Make old board Private" });
    expect(box("old board").checked).toBe(false);
    expect(calls.some((c) => c.url.includes("ask-platform"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Ask the apps" }));

    await screen.findByText("Recorded the channel type of 1 room.");
    await waitFor(() => expect(box("old board").checked).toBe(true));
  });

  it("warns on confirm when a ticked room has no recorded type", async () => {
    serve([OLD, OPS]);
    show();
    await screen.findByRole("checkbox", { name: "Make old board Private" });
    fireEvent.click(box("old board"));
    fireEvent.click(screen.getByRole("button", { name: "Make 2 rooms Private" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/1 of these has no recorded channel type/)).toBeTruthy();
  });

  it("keeps the dialog open with the error when the change is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? new Response(JSON.stringify({ detail: "Tenant admin access required" }), {
              status: 403,
            })
          : new Response(JSON.stringify({ rooms: [OPS] })),
      ),
    );
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Make 1 room Private" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Make Private" }));

    await within(dialog).findByText("Tenant admin access required");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: "Make Private" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("doesn't offer to ask about rooms the apps already couldn't place", async () => {
    serve([
      room({
        room_id: "r5",
        name: "gone",
        channel_type: null,
        cautions: ["channel_type_unknown"],
        recommended: false,
      }),
      OPS,
    ]);
    show();
    await screen.findByRole("checkbox", { name: "Make gone Private" });

    expect(screen.queryByRole("button", { name: "Ask the apps" })).toBeNull();
    expect(screen.getByText(CAUTION_TEXT.channel_type_unknown)).toBeTruthy();
  });

  it("refuses more than 200 rooms at once", async () => {
    serve(Array.from({ length: 201 }, (_, i) => room({ room_id: `r${i}`, name: `room ${i}` })));
    show();

    const button = await screen.findByRole("button", { name: "Make 201 rooms Private" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Make at most 200 Private at a time/)).toBeTruthy();
  });
});

describe("labels", () => {
  it("adds the untyped warning to the confirm text only when needed", () => {
    expect(confirmText(0)).not.toMatch(/recorded/);
    expect(confirmText(3)).toMatch(/3 of these have no recorded channel type/);
  });

  it("names channel types", () => {
    expect(channelLabel("channel_private")).toBe("Private channel");
    expect(channelLabel(null)).toBe("Not recorded");
  });

  it("says which rooms were skipped and why", () => {
    const names = new Map([["r1", "ops"]]);
    expect(
      describeResult({ changed: [], skipped: [{ room_id: "r1", reason: "archived" }] }, names),
    ).toBe("Made 0 rooms Private. ops was skipped: it was archived.");
  });

  it("says when the app asked to slow down", () => {
    expect(
      describeAsk({
        answered: [{ room_id: "r1", channel_type: "channel_private" }],
        unanswered: [{ room_id: "r2", reason: "could_not_tell" }],
        stopped: "rate_limited",
        remaining: 5,
      }),
    ).toBe(
      "Recorded the channel type of 1 room. The app couldn't say for 1 room; check those by hand. The app asked Switch to slow down, so it stopped there. Try again in a minute.",
    );
  });
});
