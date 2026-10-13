import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeDetail, InstalledApp } from "../../data/api";
import DeleteConnectionText from "./DeleteConnectionText";
import { deleteConnection } from "./deleteConnection";

function bridge(overrides: Partial<BridgeDetail> = {}): BridgeDetail {
  return {
    bridge_id: "b1",
    bridge_type: "telegram",
    display_name: "Telegram",
    status: "active",
    room_count: 2,
    ...overrides,
  } as BridgeDetail;
}

function chat(id: string, overrides: Partial<InstalledApp> = {}): InstalledApp {
  return {
    id,
    platform: "telegram",
    external_workspace_id: `-100${id}`,
    status: "active",
    scopes: "",
    bridge_id: "b1",
    installed_at: "2026-01-01",
    ended_at: null,
    ...overrides,
  };
}

/** Answers each request from `routes` by method and path, and records it. */
function stubFetch(routes: Record<string, [number, unknown]>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${String(url).replace("/gateway", "")}`;
      calls.push(key);
      const [status, body] = routes[key] ?? [500, { detail: `unexpected ${key}` }];
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("deleteConnection", () => {
  it("disconnects every chat still connected, then deletes the connection", async () => {
    const calls = stubFetch({
      "GET /messaging-apps/installs": [
        200,
        {
          installs: [
            chat("1"),
            chat("2"),
            chat("3", { status: "disconnected" }),
            chat("4", { bridge_id: "another" }),
          ],
        },
      ],
      "DELETE /messaging-apps/installs/1": [200, chat("1")],
      "DELETE /messaging-apps/installs/2": [200, chat("2")],
      "DELETE /collaborations/b1": [200, { ok: true }],
    });

    await deleteConnection(bridge());

    expect(calls).toEqual([
      "GET /messaging-apps/installs",
      "DELETE /messaging-apps/installs/1",
      "DELETE /messaging-apps/installs/2",
      "DELETE /collaborations/b1",
    ]);
  });

  it("carries on past a chat someone else already disconnected", async () => {
    const calls = stubFetch({
      "GET /messaging-apps/installs": [200, { installs: [chat("1"), chat("2")] }],
      "DELETE /messaging-apps/installs/1": [404, { detail: "Install not found" }],
      "DELETE /messaging-apps/installs/2": [200, chat("2")],
      "DELETE /collaborations/b1": [200, { ok: true }],
    });

    await deleteConnection(bridge());

    expect(calls).toContain("DELETE /collaborations/b1");
  });

  it("stops at a chat the bot cannot leave, leaving the connection in place", async () => {
    const calls = stubFetch({
      "GET /messaging-apps/installs": [200, { installs: [chat("1"), chat("2")] }],
      "DELETE /messaging-apps/installs/1": [
        502,
        { detail: "Telegram refused to let the bot leave chat -1001." },
      ],
    });

    await expect(deleteConnection(bridge())).rejects.toThrow(
      "Telegram refused to let the bot leave chat -1001.",
    );
    expect(calls).not.toContain("DELETE /messaging-apps/installs/2");
    expect(calls).not.toContain("DELETE /collaborations/b1");
  });

  it("deletes any other connection directly, without reading installs", async () => {
    const calls = stubFetch({ "DELETE /collaborations/b1": [200, { ok: true }] });

    await deleteConnection(bridge({ bridge_type: "teams" }));

    expect(calls).toEqual(["DELETE /collaborations/b1"]);
  });
});

describe("DeleteConnectionText", () => {
  it("says a Telegram connection's chats are disconnected first and keep their rooms", async () => {
    stubFetch({
      "GET /messaging-apps/installs": [200, { installs: [chat("1"), chat("2")] }],
    });

    render(<DeleteConnectionText bridge={bridge()} />);

    const text = await screen.findByText(/2 chats are still connected/);
    expect(text.textContent).toContain("internal-only room");
    expect(text.textContent).not.toContain("delete all");
  });

  it("warns that rooms go with any other connection, without asking the server", () => {
    const calls = stubFetch({});

    render(<DeleteConnectionText bridge={bridge({ bridge_type: "slack", display_name: "Acme" })} />);

    expect(
      screen.getByText(/This will also delete all 2 associated rooms and external users/),
    ).toBeTruthy();
    expect(calls).toEqual([]);
  });
});
