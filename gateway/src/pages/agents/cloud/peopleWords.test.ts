import { describe, expect, it } from "vitest";
import type { CloudMachine } from "../../../data/hostedCloud";
import { EMPTY, RESTING_EXPLANATION, SETUP_WORDS, setupChecklist } from "./peopleWords";

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
