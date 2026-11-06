import { describe, expect, it } from "vitest";
import type { CloudMachine } from "../../../data/hostedCloud";
import {
  EMPTY,
  RESTING_EXPLANATION,
  SETUP_WORDS,
  agentProvider,
  loginTick,
  setupChecklist,
} from "./peopleWords";

function box(overrides: Partial<CloudMachine> = {}): CloudMachine {
  return {
    machine_id: "m-1",
    state: "ready",
    desired_state: "running",
    stop_reason: null,
    sleeping: false,
    revision: 3,
    error: null,
    error_code: null,
    agents: ["a1"],
    controller_id: "c-1",
    backend: "box",
    room: null,
    awake: null,
    ai_calls_today: null,
    ...overrides,
  };
}

describe("the words, exactly as Console copies them", () => {
  it("keeps every string fixed", () => {
    expect(RESTING_EXPLANATION).toBe(
      "Your cloud is resting to save resources. It wakes in about a minute when you message an agent or press Wake it.",
    );
    expect(EMPTY).toEqual({
      noAgents: "Add your first agent on Switch cloud",
      noLogin: "Give your agent a login so it can answer",
      noFiles: "Your agents' files appear here once they make something",
    });
    expect(SETUP_WORDS).toEqual({
      cloud: { done: "Your cloud is ready", todo: "Your cloud is stopped", action: "Start" },
      login: { done: "AI login set", todo: "No AI login yet", action: "Give login" },
      agent: { done: "First agent added", todo: "No agent yet", action: "Add agent" },
    });
  });
});

describe("setupChecklist", () => {
  it("folds away once the cloud is up, a login is set and an agent is added", () => {
    expect(setupChecklist(box(), true)).toBeNull();
    // Resting counts as ready: it wakes by itself.
    expect(setupChecklist(box({ sleeping: true }), true)).toBeNull();
  });

  it("offers each missing step's button", () => {
    expect(setupChecklist(box({ agents: [] }), false)).toEqual([
      { step: "cloud", done: true, text: "Your cloud is ready" },
      { step: "login", done: false, text: "No AI login yet", action: "Give login" },
      { step: "agent", done: false, text: "No agent yet", action: "Add agent" },
    ]);
  });

  it("offers Start for a box the person can start", () => {
    for (const stopped of [
      box({ state: "retained" }),
      box({ state: "stopped", desired_state: "stopped" }),
    ])
      expect(setupChecklist(stopped, true)?.[0]).toEqual({
        step: "cloud",
        done: false,
        text: "Your cloud is stopped",
        action: "Start",
      });
  });

  it("gives no button where Switch would refuse it, and says why in the panel's words", () => {
    expect(setupChecklist(box({ stop_reason: "paused", state: "stopped" }), true)?.[0]).toEqual({
      step: "cloud",
      done: false,
      text: "Paused by Switch",
      note: "Contact your admin",
    });
    expect(setupChecklist(box({ state: "provisioning" }), true)?.[0]).toEqual({
      step: "cloud",
      done: false,
      text: "Starting…",
      note: "Usually ready in about two minutes.",
    });
  });
});

describe("agentProvider", () => {
  it("maps each of Core's five agent types to its provider", () => {
    expect(agentProvider("claude-code")).toBe("claude");
    expect(agentProvider("cursor")).toBe("cursor");
    expect(agentProvider("codex")).toBe("codex");
    expect(agentProvider("opencode")).toBe("opencode");
    expect(agentProvider("antigravity")).toBe("antigravity");
    expect(agentProvider("something-new")).toBeNull();
    expect(agentProvider("toString")).toBeNull();
    expect(agentProvider(null)).toBeNull();
    expect(agentProvider(undefined)).toBeNull();
  });
});

describe("loginTick", () => {
  const takes = new Set(["claude", "codex"]);

  it("with no agents, any ready login ticks it", () => {
    expect(loginTick([], new Set(["codex"]), takes)).toEqual({ set: true, missing: null });
    expect(loginTick([], new Set(), takes)).toEqual({ set: false, missing: null });
  });

  it("with agents, ticks once every provider they use is ready", () => {
    expect(loginTick(["claude", "codex", "claude"], new Set(["claude", "codex"]), takes)).toEqual({
      set: true,
      missing: null,
    });
  });

  it("with one provider missing, isn't ticked and Give login opens that one", () => {
    // A Codex login alone doesn't help a Claude agent.
    expect(loginTick(["claude"], new Set(["codex"]), takes)).toEqual({ set: false, missing: "claude" });
    // The first agent's missing provider, in the list's order.
    expect(loginTick(["claude", "codex"], new Set(), takes)).toEqual({ set: false, missing: "claude" });
    expect(loginTick(["claude", "codex"], new Set(["claude"]), takes)).toEqual({ set: false, missing: "codex" });
  });

  it("counts a Cursor agent once the box takes a Cursor login", () => {
    expect(loginTick([agentProvider("cursor")], new Set(["claude"]), new Set(["claude", "cursor"]))).toEqual({
      set: false,
      missing: "cursor",
    });
  });

  it("leaves out an agent on an unknown provider, or one the box takes no login for", () => {
    expect(loginTick([null, "opencode", "claude"], new Set(["claude"]), takes)).toEqual({
      set: true,
      missing: null,
    });
    // Nothing left: any ready login ticks it, as with no agents.
    expect(loginTick([null, "opencode"], new Set(["codex"]), takes)).toEqual({ set: true, missing: null });
    expect(loginTick([null], new Set(), takes)).toEqual({ set: false, missing: null });
  });
});
