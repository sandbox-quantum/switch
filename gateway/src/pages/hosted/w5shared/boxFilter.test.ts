import { describe, expect, it } from "vitest";
import type { BoxState, OverviewBox } from "../overview/overview";
import { BOX_FILTERS, boxGroup, filterBoxes, filterCounts, isCurrent, keptUntil } from "./boxFilter";

const row = (box: string, state: BoxState, extra: Partial<OverviewBox> = {}): OverviewBox => ({
  box,
  user: `k1-user${box.slice(-4)}00000000`,
  workspaces: ["k1-7c10ab12cd34ef56"],
  state,
  node: "ip-10-0-0-1",
  memoryUsedBytes: null,
  restartsToday: null,
  memoryTotalBytes: null,
  awake: null,
  activeAt: null,
  heartbeatAt: null,
  runningObservedAt: null,
  retainUntil: null,
  ...extra,
});

const BOXES = [
  row("k1-aaaa000000000001", "running"),
  row("k1-aaaa000000000002", "starting"),
  row("k1-aaaa000000000003", "resting"),
  row("k1-aaaa000000000004", "stopped"),
  row("k1-aaaa000000000005", "paused"),
  row("k1-aaaa000000000006", "error"),
  row("k1-aaaa000000000007", "stopping"),
  row("k1-aaaa000000000008", "retired", { node: "ip-10-0-9-9" }),
];

const ids = (rows: OverviewBox[]) => rows.map((r) => r.box.slice(-1));

describe("the Hosted state filter", () => {
  it("groups every Core box state under one chip", () => {
    expect(boxGroup("running")).toBe("awake");
    expect(boxGroup("starting")).toBe("awake");
    expect(boxGroup("resting")).toBe("resting");
    for (const state of ["stopped", "paused", "error", "stopping"] as const)
      expect(boxGroup(state)).toBe("stopped");
    expect(boxGroup("retired")).toBe("putAway");
    expect(isCurrent({ state: "retired" })).toBe(false);
    expect(isCurrent({ state: "resting" })).toBe(true);
  });

  it("keeps put-away boxes out of the current list, and shows them on their own", () => {
    expect(ids(filterBoxes(BOXES, "current", ""))).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(ids(filterBoxes(BOXES, "putAway", ""))).toEqual(["8"]);
    expect(ids(filterBoxes(BOXES, "all", ""))).toHaveLength(8);
    expect(ids(filterBoxes(BOXES, "awake", ""))).toEqual(["1", "2"]);
    expect(ids(filterBoxes(BOXES, "stopped", ""))).toEqual(["4", "5", "6", "7"]);
  });

  it("searches ids and machines, ignoring case and the id cell's spaces", () => {
    expect(ids(filterBoxes(BOXES, "all", "K1-AAAA 0000 0000 0003"))).toEqual(["3"]);
    expect(ids(filterBoxes(BOXES, "all", "user0005"))).toEqual(["5"]);
    expect(ids(filterBoxes(BOXES, "all", "10-0-9-9"))).toEqual(["8"]);
    // A search never pulls a put-away box into the current list.
    expect(ids(filterBoxes(BOXES, "current", "10-0-9-9"))).toEqual([]);
    expect(filterBoxes(BOXES, "all", "nothing-like-this")).toEqual([]);
  });

  it("counts each chip", () => {
    expect(filterCounts(BOXES)).toEqual({
      current: 7,
      awake: 2,
      resting: 1,
      stopped: 4,
      putAway: 1,
      all: 8,
    });
  });
});

describe("put-away boxes", () => {
  it("offers Current first, and All means everything", () => {
    expect(BOX_FILTERS.map((f) => f.label)).toEqual([
      "Current",
      "Awake",
      "Resting",
      "Stopped",
      "Put away",
      "All",
    ]);
  });

  it("say when they go for good, in plain words", () => {
    const now = new Date("2026-11-06T12:00:00Z");
    expect(keptUntil("2026-11-20T00:00:00+00:00", now)).toBe("Kept until 20 Nov");
    expect(keptUntil("2027-01-03T00:00:00+00:00", now)).toBe("Kept until 3 Jan 2027");
    expect(keptUntil(null, now)).toBeNull();
    expect(keptUntil("not a date", now)).toBeNull();
  });
});
