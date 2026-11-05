import { describe, expect, it } from "vitest";
import type { CloudMachine } from "../../../data/hostedCloud";
import { boxShowsStopped, machineProblem, startBlocked, yourCloudView } from "./yourCloud";

const time = (at: Date) => at.toISOString().slice(11, 16);

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

describe("yourCloudView", () => {
  it.each([
    [{ stop_reason: "paused" as const }, "Paused by Switch", "Contact your admin", undefined],
    [
      { stop_reason: "turned_off" as const },
      "Turned off by your admin",
      "Ask your admin to turn it on",
      undefined,
    ],
    [{ state: "retained" as const }, "Stopped", "Start it to add or use an agent.", "ensure"],
    [
      { desired_state: "retained" as const, state: "stopped" as const },
      "Stopped",
      "Start it to add or use an agent.",
      "ensure",
    ],
    [{ state: "queued" as const }, "Starting…", "Usually ready in about two minutes.", undefined],
    [
      { state: "provisioning" as const },
      "Starting…",
      "Usually ready in about two minutes.",
      undefined,
    ],
    [
      { state: "stopping" as const },
      "Stopping…",
      "Start it again once it has stopped.",
      undefined,
    ],
    [
      { sleeping: true, state: "stopped" as const, agents: [] },
      "Resting",
      "Start it to add an agent.",
      "ensure",
    ],
    [
      { state: "stopped" as const, desired_state: "running" as const },
      "Starting…",
      "Usually ready in about two minutes.",
      undefined,
    ],
    [
      { state: "stopped" as const, desired_state: "stopped" as const, stop_reason: "owner" as const },
      "Stopped",
      "Start it to use your agents.",
      "lifecycle",
    ],
    [{ state: "error" as const }, "Stopped", "Not running right now.", undefined],
  ])("%o reads %s · %s", (overrides, heading, line, start) => {
    expect(yourCloudView(box(overrides), time)).toEqual({
      resting: true,
      heading,
      line,
      ...(start ? { start } : {}),
    });
  });

  it("offers Wake on a resting box with agents, and Start on one with none", () => {
    expect(yourCloudView(box({ sleeping: true, state: "stopped" }), time)).toEqual({
      resting: true,
      heading: "Resting",
      line: "Starts when you message an agent.",
      start: "ensure",
      startLabel: "Wake",
    });
    const empty = yourCloudView(box({ sleeping: true, state: "stopped", agents: [] }), time);
    expect(empty.resting && empty.startLabel).toBeUndefined();
  });

  it("tells the agents list to say Stopped only when the panel does", () => {
    expect(boxShowsStopped(box({ state: "retained" }))).toBe(true);
    expect(boxShowsStopped(box({ state: "stopped", desired_state: "stopped" }))).toBe(true);
    expect(boxShowsStopped(box({ state: "error" }))).toBe(true);
    expect(boxShowsStopped(box())).toBe(false);
    expect(boxShowsStopped(box({ sleeping: true, state: "stopped" }))).toBe(false);
    expect(boxShowsStopped(box({ state: "queued" }))).toBe(false);
    expect(boxShowsStopped(box({ state: "retained", stop_reason: "paused" }))).toBe(false);
    expect(boxShowsStopped(box({ state: "stopped", stop_reason: "turned_off" }))).toBe(false);
  });

  it("never says Ready for a box that is put away or stopped", () => {
    for (const overrides of [
      { state: "retained" as const },
      { state: "stopped" as const, desired_state: "stopped" as const },
      { state: "stopped" as const, desired_state: "retained" as const },
    ]) {
      const view = yourCloudView(box({ ...overrides, room: { used_bytes: 1, total_bytes: 10 } }), time);
      expect(view.heading).not.toBe("Ready");
      expect(view.resting).toBe(true);
    }
  });

  it("a pause wins over a put-away box", () => {
    const view = yourCloudView(box({ state: "retained", stop_reason: "paused" }), time);
    expect(view).toEqual({ resting: true, heading: "Paused by Switch", line: "Contact your admin" });
  });

  it("shows the figures while the box is up", () => {
    const view = yourCloudView(
      box({
        room: { used_bytes: 4, total_bytes: 10 },
        awake: { running: 3, max: 15 },
        ai_calls_today: {
          used: 40,
          cap: 200,
          capped: false,
          resets_at: "2026-11-06T01:00:00Z",
        },
      }),
      time,
    );
    expect(view).toEqual({
      resting: false,
      heading: "Ready",
      room: { usedPercent: 40, step: "plenty", label: "Plenty of room" },
      awake: { label: "3 of 15 awake" },
      aiCalls: { label: "40 of 200 AI calls today, resets at 01:00", capped: false },
    });
  });

  it.each([
    [0.8, "Ready", "Plenty of room", 80],
    [0.81, "Nearly full", "A little left", 81],
    [0.95, "Full right now", "Full right now", 95],
    [1.2, "Full right now", "Full right now", 100],
  ])("room at %f reads %s", (share, heading, label, percent) => {
    const view = yourCloudView(box({ room: { used_bytes: share * 1000, total_bytes: 1000 } }), time);
    expect(view.resting).toBe(false);
    if (view.resting) return;
    expect(view.heading).toBe(heading);
    expect(view.room?.label).toBe(label);
    expect(view.room?.usedPercent).toBe(percent);
  });

  it("says when today's AI limit is reached", () => {
    const view = yourCloudView(
      box({
        ai_calls_today: { used: 200, cap: 200, capped: true, resets_at: "2026-11-06T01:00:00Z" },
      }),
      time,
    );
    expect(view.resting === false && view.aiCalls).toEqual({
      label: "Today's AI limit is reached (200). It resets at 01:00.",
      capped: true,
    });
  });
});

describe("startBlocked and machineProblem", () => {
  it("blocks Start only when Switch paused it or an admin turned it off", () => {
    expect(startBlocked({ stop_reason: "paused" })).toBe(true);
    expect(startBlocked({ stop_reason: "turned_off" })).toBe(true);
    expect(startBlocked({ stop_reason: "owner" })).toBe(false);
    expect(startBlocked({ stop_reason: null })).toBe(false);
  });

  it("words a failed start as Console does", () => {
    expect(machineProblem(box())).toBeNull();
    expect(machineProblem(box({ state: "error" }))).toBe("The machine could not start.");
    expect(machineProblem(box({ state: "error", error: "no capacity" }))).toBe("no capacity");
    expect(machineProblem(box({ state: "error", error_code: "machine_needs_attention" }))).toBe(
      "The machine needs attention. Contact your server administrator.",
    );
    expect(machineProblem(box({ error_code: "disk_full" }))).toBe("The machine’s disk is full.");
  });
});
