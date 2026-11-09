import { describe, expect, it } from "vitest";
import {
  type AgentCounts,
  type DetailBox,
  type DetailOverview,
  NO_AGENTS,
  boxDetail,
  boxMemory,
  boxSlice,
  boxSlices,
  machineDetail,
  runningSince,
} from "./detail";

const GB = 1024 ** 3;

function box(over: Partial<DetailBox> = {}): DetailBox {
  return {
    box: "k1-box-1",
    user: "k1-user-1",
    workspaces: ["k1-ws-1"],
    state: "running",
    node: "node-a",
    memoryUsedBytes: 1 * GB,
    memoryTotalBytes: 4 * GB,
    restartsToday: 0,
    awake: { running: 2, max: 12 },
    activeAt: "2026-11-06T09:00:00+00:00",
    heartbeatAt: "2026-11-06T09:01:00+00:00",
    runningObservedAt: "2026-11-06T08:30:00+00:00",
    ...over,
  };
}

function counts(over: Partial<AgentCounts>): AgentCounts {
  return { ...NO_AGENTS, ...over };
}

const overview: DetailOverview = {
  boxes: [
    box(),
    box({ box: "k1-box-2", user: "k1-user-2", state: "resting" }),
    box({ box: "k1-box-3", user: "k1-user-3", state: "retired" }),
    box({ box: "k1-box-4", user: "k1-user-4", node: "node-b", state: "stopped" }),
  ],
  machines: [
    { name: "node-a", machine: "k1-machine-a", zone: "z1", memoryUsedPct: 81.4, memoryBookedPct: 96 },
    { name: "node-b", machine: "k1-machine-b", zone: "z1", memoryUsedPct: null, memoryBookedPct: null },
  ],
  agentsByUser: new Map([
    ["k1-user-1", counts({ working: 1, idle: 2 })],
    ["k1-user-2", counts({ resting: 3 })],
    ["k1-user-4", counts({ unavailable: 1 })],
  ]),
  reportAt: "2026-11-06T09:00:00+00:00",
  reportStale: false,
};

describe("the machine page", () => {
  it("counts its own boxes by state, keeping empty slices for a steady legend", () => {
    const detail = machineDetail(overview, "k1-machine-a")!;
    expect(detail.boxes.map((b) => b.box)).toEqual(["k1-box-1", "k1-box-2", "k1-box-3"]);
    expect(detail.boxSlices.map((s) => [s.key, s.count])).toEqual([
      ["awake", 1],
      ["resting", 1],
      ["stopped", 0],
      ["other", 1],
    ]);
  });

  it("adds up the agents of its boxes' owners, and counts a box with none as none", () => {
    const detail = machineDetail(overview, "k1-machine-a")!;
    expect(detail.agentSlices.map((s) => [s.key, s.count])).toEqual([
      ["working", 1],
      ["idle", 2],
      ["resting", 3],
      ["unavailable", 0],
    ]);
  });

  it("shows memory used and booked as percentage bars, warning only where the Machines tab does", () => {
    const detail = machineDetail(overview, "k1-machine-a")!;
    expect(detail.memoryUsed).toMatchObject({ label: "Memory used: 81%", step: "ok" });
    // Booked is a planning figure: never a warning, even at 96%.
    expect(detail.memoryBooked).toMatchObject({ label: "Memory booked: 96%", step: "ok" });
    const hot = machineDetail(
      { ...overview, machines: [{ ...overview.machines[0], memoryUsedPct: 85.4 }] },
      "k1-machine-a",
    )!;
    expect(hot.memoryUsed?.step).toBe("full");
  });

  it("says nothing it doesn't know: missing figures are null, for Not available", () => {
    const detail = machineDetail(overview, "k1-machine-b")!;
    expect(detail.memoryUsed).toBeNull();
    expect(detail.memoryBooked).toBeNull();
  });

  it("finds a machine only by its keyed id", () => {
    expect(machineDetail(overview, "node-a")).toBeNull();
    expect(machineDetail(overview, "k1-unknown")).toBeNull();
  });
});

describe("the box page", () => {
  it("has its node and its owner's agents", () => {
    const detail = boxDetail(overview, "k1-box-1")!;
    expect(detail.machine?.machine).toBe("k1-machine-a");
    expect(detail.agentSlices.map((s) => s.count)).toEqual([1, 2, 0, 0]);
  });

  it("has no agents for an owner the overview doesn't count, and no node it can't find", () => {
    const detail = boxDetail(
      { ...overview, boxes: [box({ box: "k1-box-9", user: "k1-nobody", node: "gone" })] },
      "k1-box-9",
    )!;
    expect(detail.agentSlices.every((s) => s.count === 0)).toBe(true);
    expect(detail.machine).toBeNull();
  });

  it("finds a box only by its keyed id", () => {
    expect(boxDetail(overview, "k1-nope")).toBeNull();
  });

  it("words memory only with both figures", () => {
    expect(boxMemory(box())).toEqual({ used_bytes: 1 * GB, total_bytes: 4 * GB });
    expect(boxMemory(box({ memoryTotalBytes: null }))).toBeNull();
    expect(boxMemory(box({ memoryUsedBytes: null }))).toBeNull();
  });

  it("shows Running since only while the box is awake", () => {
    expect(runningSince(box())).toBe("2026-11-06T08:30:00+00:00");
    expect(runningSince(box({ state: "resting" }))).toBeNull();
  });
});

describe("box state slices", () => {
  it.each([
    ["running", "awake"],
    ["starting", "awake"],
    ["resting", "resting"],
    ["stopped", "stopped"],
    ["stopping", "stopped"],
    ["paused", "other"],
    ["error", "other"],
    ["retired", "other"],
  ] as const)("%s counts as %s", (state, slice) => {
    expect(boxSlice(state)).toBe(slice);
  });

  it("totals every box once", () => {
    const slices = boxSlices(overview.boxes);
    expect(slices.reduce((sum, s) => sum + s.count, 0)).toBe(overview.boxes.length);
  });
});
