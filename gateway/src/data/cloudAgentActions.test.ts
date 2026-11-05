import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCloudAgentRunning,
  restartCloudAgent,
  setCloudAgentDisplayName,
  setCloudAgentRunning,
} from "./cloudAgentActions";

type Call = { method: string; url: string; body: unknown };
let calls: Call[];
let answer: (call: Call) => Response | undefined;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  calls = [];
  answer = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = {
        method: init?.method ?? "GET",
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return answer(call) ?? json({ ok: true });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const said = () => calls.map((c) => `${c.method} ${c.url}`);

describe("start, stop and restart", () => {
  it("starts and stops through the management PATCH, as Console does", async () => {
    await setCloudAgentRunning("a", true);
    await setCloudAgentRunning("a", false);
    expect(said()).toEqual([
      "PATCH /gateway/management/agents/a",
      "PATCH /gateway/management/agents/a",
    ]);
    expect(calls.map((c) => c.body)).toEqual([
      { desired_state: "running" },
      { desired_state: "stopped" },
    ]);
  });

  it("restarts as stop then start", async () => {
    await restartCloudAgent("a");
    expect(calls.map((c) => c.body)).toEqual([
      { desired_state: "stopped" },
      { desired_state: "running" },
    ]);
  });

  it("doesn't start again when the stop is refused", async () => {
    answer = () => json({ error: { code: "forbidden", message: "Not your agent." } }, 403);
    await expect(restartCloudAgent("a")).rejects.toThrow("Not your agent.");
    expect(calls).toHaveLength(1);
  });

  it("reads whether the owner wants it running", async () => {
    answer = () =>
      json([
        { agent_id: "a", desired_state: "running" },
        { agent_id: "b", desired_state: "stopped" },
      ]);
    expect(await fetchCloudAgentRunning("a")).toBe(true);
    expect(await fetchCloudAgentRunning("b")).toBe(false);
    expect(await fetchCloudAgentRunning("not-managed")).toBeNull();
  });
});

describe("rename", () => {
  it("changes the display name only, never the name", async () => {
    await setCloudAgentDisplayName("a", "  Site builder ");
    await setCloudAgentDisplayName("a", "   ");
    expect(said()).toEqual([
      "PUT /gateway/agents/a/display-name",
      "PUT /gateway/agents/a/display-name",
    ]);
    expect(calls.map((c) => c.body)).toEqual([
      { display_name: "Site builder" },
      { display_name: null },
    ]);
    expect(said().some((line) => line.endsWith("/name"))).toBe(false);
  });

  it("shows the server's words when it refuses", async () => {
    answer = () => json({ detail: "Display name is too long." }, 400);
    await expect(setCloudAgentDisplayName("a", "x")).rejects.toThrow(
      "Display name is too long.",
    );
  });
});
