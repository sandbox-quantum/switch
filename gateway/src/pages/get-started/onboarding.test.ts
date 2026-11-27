import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudMachine, Controller } from "../../data/management";
import { LONG_REQUEST_TIMEOUT_MS } from "../../data/gatewayFetch";
import { answerFetch } from "../../test/answerFetch";
import {
  createBuddy,
  loginOutcome,
  needsWaking,
  START_OVER_POLL_MS,
  startOver,
  welcomeChat,
} from "./onboarding";

const client = vi.hoisted(() => ({ listChats: vi.fn(), createChat: vi.fn() }));
vi.mock("../chats/webChatClient", () => ({ webChatsClient: client }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const template = { name: "switch-buddy", content: "version: 2" };
const person = { name: "Ada Lovelace", email: "ada@example.com" };

describe("loginOutcome", () => {
  it("is pending until the machine finishes, then says how it went", async () => {
    answerFetch({
      "GET /management/operations": [
        [200, [{ id: "op1", state: "claimed" }]],
        [200, [{ id: "op1", state: "succeeded", result: { outcome: "ok" } }]],
      ],
    });
    expect(await loginOutcome("c1", "op1")).toEqual({ state: "pending" });
    expect(await loginOutcome("c1", "op1")).toEqual({ state: "succeeded" });
  });

  it("carries the machine's own reason for a login it could not use", async () => {
    answerFetch({
      "GET /management/operations": [
        200,
        [
          {
            id: "op1",
            state: "failed",
            result: { error: { code: "bad", message: "That token was refused." } },
          },
        ],
      ],
    });
    expect(await loginOutcome("c1", "op1")).toEqual({
      state: "failed",
      message: "That token was refused.",
    });
  });
});

describe("createBuddy", () => {
  it("creates switch-buddy on the cloud device, trying the next name when one is taken", async () => {
    const calls = answerFetch({
      "GET /management/agents": [200, []],
      "GET /templates/official%3Aswitch-buddy": [200, template],
      "POST /rooms/from-template-document": [
        [
          409,
          {
            code: "invalid",
            detail: "taken",
            problems: [{ code: "name_taken", message: "Taken." }],
          },
        ],
        [200, { created_agents: [{ agent_id: "a1", name: "switch-buddy-ada-lovelace-2" }] }],
      ],
      "POST /templates/official%3Aswitch-buddy/runs": [204, {}],
    });
    expect(await createBuddy({ controllerId: "c1", provider: "claude", person })).toEqual({
      agentId: "a1",
      name: "switch-buddy-ada-lovelace-2",
    });
    const runs = calls.filter((call) => call.path === "/rooms/from-template-document");
    expect(runs.map((run) => (run.body as { inputs: unknown }).inputs)).toEqual([
      { agent_name: "switch-buddy-ada-lovelace", provider: "claude", machine: "c1" },
      { agent_name: "switch-buddy-ada-lovelace-2", provider: "claude", machine: "c1" },
    ]);
  });

  it("answers the buddy the person already has", async () => {
    const calls = answerFetch({
      "GET /management/agents": [
        200,
        [
          {
            agent_id: "a9",
            name: "switch-buddy-ada",
            template: { id: "official:switch-buddy", key: "buddy" },
          },
        ],
      ],
    });
    expect(await createBuddy({ controllerId: "c1", provider: "claude", person })).toEqual({
      agentId: "a9",
      name: "switch-buddy-ada",
    });
    expect(calls.map((call) => call.path)).toEqual(["/management/agents"]);
  });

  it("says why the server refused the template", async () => {
    answerFetch({
      "GET /management/agents": [200, []],
      "GET /templates/official%3Aswitch-buddy": [200, template],
      "POST /rooms/from-template-document": [
        409,
        {
          code: "invalid",
          detail: "No.",
          problems: [{ code: "provider_login_missing", message: "Sign in to Claude first." }],
        },
      ],
    });
    await expect(createBuddy({ controllerId: "c1", provider: "claude", person })).rejects.toThrow(
      "Sign in to Claude first.",
    );
  });
});

describe("needsWaking", () => {
  it("is a device asleep or stopped by its owner, never one an admin stopped", () => {
    const machine = (overrides: Partial<CloudMachine>) =>
      ({ desired_state: "running", sleeping: false, stopped_by_admin: false, ...overrides }) as CloudMachine;
    expect(needsWaking(machine({}))).toBe(false);
    expect(needsWaking(machine({ sleeping: true }))).toBe(true);
    expect(needsWaking(machine({ desired_state: "stopped" }))).toBe(true);
    expect(needsWaking(machine({ desired_state: "stopped", stopped_by_admin: true }))).toBe(false);
  });
});

describe("startOver", () => {
  it("has the server wipe workspaces it can, then deletes switch-buddy and sealed logins client-side", async () => {
    vi.useFakeTimers();
    const calls = answerFetch({
      "DELETE /agents/a1": [200, { ok: true }],
      "DELETE /management/controllers/c1/provider-logins/claude": [200, { ok: true }],
      "POST /auth/me/start-over": [
        [200, { finished: false, waiting: "being torn down" }],
        [200, { finished: true, waiting: null }],
      ],
    });
    const done = startOver({
      buddyId: "a1",
      controller: {
        id: "c1",
        status: {
          providers: [
            { provider: "claude", installed: true, auth: "ok", auth_source: "sealed" },
            { provider: "codex", installed: true, auth: "ok", auth_source: "local" },
          ],
        },
      } as unknown as Controller,
      email: "ada@example.com",
    });
    await vi.advanceTimersByTimeAsync(START_OVER_POLL_MS);
    await done;
    vi.useRealTimers();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /auth/me/start-over",
      "POST /auth/me/start-over",
      "DELETE /agents/a1",
      "DELETE /management/controllers/c1/provider-logins/claude",
    ]);
    expect(calls[0]!.body).toEqual({ email: "ada@example.com" });
  });
});

describe("startOver while the server is slow", () => {
  it("asks again when one ask outlasts its wait, as the server carries on", async () => {
    vi.useFakeTimers();
    let asked = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        asked += 1;
        if (asked === 1)
          return new Promise((_resolve, reject) =>
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
          );
        return Promise.resolve(
          new Response(JSON.stringify({ finished: true, waiting: null }), { status: 200 }),
        );
      }),
    );
    const done = startOver({ buddyId: null, controller: null, email: "ada@example.com" });
    await vi.advanceTimersByTimeAsync(LONG_REQUEST_TIMEOUT_MS + START_OVER_POLL_MS);
    await done;
    vi.useRealTimers();
    expect(asked).toBe(2);
  });
});

describe("welcomeChat", () => {
  it("reuses the buddy's Welcome chat", async () => {
    client.listChats.mockResolvedValue([
      { roomId: "r1", name: "Welcome", channelType: "direct", agents: [{ id: "a1" }] },
    ]);
    expect(
      await welcomeChat({ agentId: "a1", agentName: "switch-buddy-ada", firstName: "Ada" }),
    ).toBe("r1");
    expect(client.createChat).not.toHaveBeenCalled();
  });

  it("makes one opening with the buddy's welcome when there is none", async () => {
    client.listChats.mockResolvedValue([]);
    client.createChat.mockResolvedValue({ roomId: "r2" });
    expect(
      await welcomeChat({ agentId: "a1", agentName: "switch-buddy-ada", firstName: "Ada" }),
    ).toBe("r2");
    const made = client.createChat.mock.calls[0]![0] as {
      agentIds: string[];
      name: string;
      greeting: string;
    };
    expect(made.agentIds).toEqual(["a1"]);
    expect(made.name).toBe("Welcome");
    expect(made.greeting).toContain("Ada");
  });
});
