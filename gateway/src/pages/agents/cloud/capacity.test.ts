import { describe, expect, it } from "vitest";
import {
  CAPACITY_ADVICE,
  DISK_NOT_AVAILABLE,
  capacityRows,
  capacityStep,
  gb,
  workspaceDisk,
} from "./capacity";

const GB = 1024 ** 3;

describe("capacity steps", () => {
  it.each([
    [0.79, "ok"],
    [0.8, "nearly_full"],
    [0.94, "nearly_full"],
    [0.95, "full"],
    [1.0, "full"],
  ] as const)("%f is %s", (share, step) => {
    expect(capacityStep(share)).toBe(step);
  });
});

describe("capacity rows", () => {
  it("words each row as the stories do", () => {
    const rows = capacityRows({
      awake: { running: 3, max: 12 },
      room: { used_bytes: 2 * GB, total_bytes: 5 * GB },
      disk: { total_bytes: 15 * GB, available_bytes: 12.9 * GB, scope: "workspace" },
    });
    expect(rows.awake).toEqual({
      label: "Agents awake: 3 of 12",
      usedPercent: 25,
      step: "ok",
      advice: null,
    });
    expect(rows.memory?.label).toBe("Memory: 2.0 GB of 5.0 GB");
    expect(rows.disk?.label).toBe("Disk: 2.1 GB of 15.0 GB");
  });

  it.each([
    ["awake", { awake: { running: 10, max: 12 }, room: null, disk: null }, "nearly_full"],
    ["awake", { awake: { running: 12, max: 12 }, room: null, disk: null }, "full"],
    ["memory", { awake: null, room: { used_bytes: 8, total_bytes: 10 }, disk: null }, "nearly_full"],
    ["memory", { awake: null, room: { used_bytes: 96, total_bytes: 100 }, disk: null }, "full"],
    [
      "disk",
      {
        awake: null,
        room: null,
        disk: { total_bytes: 100, available_bytes: 20, scope: "workspace" as const },
      },
      "nearly_full",
    ],
    [
      "disk",
      {
        awake: null,
        room: null,
        disk: { total_bytes: 100, available_bytes: 5, scope: "workspace" as const },
      },
      "full",
    ],
  ] as const)("%s gives its own advice when %s", (kind, machine, step) => {
    const row = capacityRows(machine)[kind];
    expect(row?.step).toBe(step);
    expect(row?.advice).toBe(CAPACITY_ADVICE[kind][step]);
  });

  it("uses the PM's exact advice words, with straight apostrophes", () => {
    expect(CAPACITY_ADVICE).toEqual({
      awake: {
        nearly_full: "Nearly full. Stop agents you're not using to free places.",
        full: "Full right now. New work waits until a place frees up.",
      },
      memory: {
        nearly_full: "Nearly full. Agents may slow down.",
        full: "Full right now. Stop an agent you don't need.",
      },
      disk: {
        nearly_full: "Nearly full. Ask your agents to delete files and build output you don't need.",
        full: "Full right now. Agents can't save more until space is freed.",
      },
    });
    expect(JSON.stringify(CAPACITY_ADVICE)).not.toContain("’");
    expect(DISK_NOT_AVAILABLE).toBe("Disk: not available");
  });

  it("leaves out a row the box doesn't report", () => {
    expect(capacityRows({ awake: null, room: null, disk: null })).toEqual({
      awake: null,
      memory: null,
      disk: null,
    });
    expect(capacityRows({ awake: { running: 0, max: 0 }, room: null, disk: null }).awake).toBeNull();
  });
});

describe("the workspace disk", () => {
  const disk = { total_bytes: 15 * GB, available_bytes: 10 * GB };

  it("shows only a figure the box marks as the workspace disk", () => {
    expect(workspaceDisk({ disk: { ...disk, scope: "workspace" } })).toEqual({
      ...disk,
      scope: "workspace",
    });
    expect(workspaceDisk({ disk: { ...disk, scope: "unknown" } })).toBeNull();
    expect(workspaceDisk({ disk })).toBeNull(); // an older box: no scope
    expect(workspaceDisk({ disk: null })).toBeNull();
    expect(workspaceDisk({ disk: { total_bytes: 0, available_bytes: 0, scope: "workspace" } })).toBeNull();
  });

  it("prints gigabytes with one decimal", () => {
    expect(gb(15 * GB)).toBe("15.0 GB");
    expect(gb(2.1 * GB)).toBe("2.1 GB");
  });
});
