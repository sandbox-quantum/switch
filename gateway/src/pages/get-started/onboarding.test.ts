import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudMachine, Controller } from "../../data/management";
import { answerFetch } from "../../test/answerFetch";
import {
  createBuddy,
  loginOutcome,
  needsWaking,
  readyProvider,
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

function controller(
  providers: { provider: string; installed: boolean; auth: string }[],
): Controller {
  return { id: "c1", status: { providers } } as unknown as Controller;
}

describe("readyProvider", () => {
  it("is the first offered provider the machine reports signed in", () => {
    expect(
      readyProvider(
        controller([
          { provider: "claude", installed: true, auth: "missing" },
          { provider: "codex", installed: true, auth: "ok" },
        ]),
      ),
    ).toBe("codex");
    expect(
      readyProvider(controller([{ provider: "claude", installed: true, auth: "expired" }])),
    ).toBeNull();
    expect(readyProvider(null)).toBeNull();
  });
});

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
  it("deletes switch-buddy, takes back the device's AI logins and stops it", async () => {
    const calls = answerFetch({
      "DELETE /agents/a1": [200, { ok: true }],
      "DELETE /management/controllers/c1/provider-logins/claude": [200, { ok: true }],
      "POST /hosted-machines/m1/lifecycle": [200, { machine: {} }],
    });
    await startOver({
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
      machine: {
        machine_id: "m1",
        desired_state: "running",
        stopped_by_admin: false,
        revision: 3,
      } as unknown as CloudMachine,
    });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "DELETE /agents/a1",
      "DELETE /management/controllers/c1/provider-logins/claude",
      "POST /hosted-machines/m1/lifecycle",
    ]);
    expect(calls[2]!.body).toEqual({ action: "stop", revision: 3 });
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
