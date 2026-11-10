import { describe, expect, it } from "vitest";
import {
  applyFilters,
  countLabel,
  type FilterableColumn,
  filterOptions,
  isQuickFilterOn,
  pickOnly,
  pruneSelection,
  toggleQuickFilter,
  toggleValue,
} from "./tableFilters";

type Row = { id: number; name: string; status: string; rooms: string[] };

const rows: Row[] = [
  { id: 1, name: "release-bot", status: "Active", rooms: ["Releases"] },
  { id: 2, name: "triage-helper", status: "Idle", rooms: ["Support", "Triage"] },
  { id: 3, name: "nightly-report", status: "Active", rooms: ["Reports", "Support"] },
];

const columns: FilterableColumn<Row>[] = [
  { field: "name" },
  { field: "status", filter: { value: (row) => row.status } },
  { field: "rooms", filter: { value: (row) => row.rooms } },
];

const ids = (result: Row[]) => result.map((row) => row.id);

describe("applyFilters", () => {
  it("keeps every row when nothing is picked or searched", () => {
    expect(ids(applyFilters(rows, columns, {}, "", undefined))).toEqual([1, 2, 3]);
  });

  it("matches any value picked within a column and every column with a pick", () => {
    expect(ids(applyFilters(rows, columns, { status: ["Active", "Idle"] }, "", undefined))).toEqual([1, 2, 3]);
    expect(ids(applyFilters(rows, columns, { status: ["Active"], rooms: ["Support"] }, "", undefined))).toEqual([3]);
  });

  it("matches a row holding several values on any one of them", () => {
    expect(ids(applyFilters(rows, columns, { rooms: ["Triage"] }, "", undefined))).toEqual([2]);
  });

  it("searches the row's text, ignoring case and surrounding space", () => {
    expect(ids(applyFilters(rows, columns, {}, "  NIGHTLY ", (row) => row.name))).toEqual([3]);
  });

  it("refuses a pick on a column that has no filter", () => {
    expect(() => applyFilters(rows, columns, { name: ["release-bot"] }, "", undefined)).toThrow(/has none/);
  });
});

describe("filterOptions", () => {
  it("lists the distinct values the rows hold, sorted, when the column names none", () => {
    expect(filterOptions(columns[2], rows).map((option) => option.value)).toEqual([
      "Releases",
      "Reports",
      "Support",
      "Triage",
    ]);
  });

  it("sorts numbers within values as numbers", () => {
    const column = { field: "device", filter: { value: (row: { device: string }) => row.device } };
    const devices = ["box-10", "box-2", "box-1"].map((device) => ({ device }));

    expect(filterOptions(column, devices).map((option) => option.value)).toEqual(["box-1", "box-2", "box-10"]);
  });

  it("keeps the column's own options and their order", () => {
    const column: FilterableColumn<Row> = {
      field: "status",
      filter: { value: (row) => row.status, options: [{ value: "Idle", label: "Idle" }, { value: "Active", label: "Running" }] },
    };
    expect(filterOptions(column, rows)).toEqual([
      { value: "Idle", label: "Idle" },
      { value: "Active", label: "Running" },
    ]);
  });
});

describe("toggleValue", () => {
  it("adds a value, and drops the column once its last value is unpicked", () => {
    const picked = toggleValue({}, "status", "Active");
    expect(picked).toEqual({ status: ["Active"] });
    expect(toggleValue(picked, "status", "Active")).toEqual({});
  });
});

describe("quick filters", () => {
  const active = { field: "status", value: "Active", label: "Active" };

  it("narrows its column to exactly its value, replacing what was picked there", () => {
    const next = toggleQuickFilter({ status: ["Idle", "Active"], rooms: ["Support"] }, active);
    expect(next).toEqual({ rooms: ["Support"], status: ["Active"] });
    expect(isQuickFilterOn(next, active)).toBe(true);
  });

  it("is off while its column has other values picked too", () => {
    expect(isQuickFilterOn({ status: ["Active", "Idle"] }, active)).toBe(false);
  });

  it("clears its column when pressed again", () => {
    expect(toggleQuickFilter({ status: ["Active"] }, active)).toEqual({});
  });
});

describe("countLabel", () => {
  const noun = { one: "agent", other: "agents" };

  it("counts every row while nothing narrows the table", () => {
    expect(countLabel(12, 12, noun, false)).toBe("12 agents");
    expect(countLabel(1, 1, noun, false)).toBe("1 agent");
  });

  it("says how many of them show while something does", () => {
    expect(countLabel(3, 12, noun, true)).toBe("3 of 12 agents");
  });
});

describe("pickOnly", () => {
  it("narrows the column to the one value, replacing what it had", () => {
    expect(pickOnly({ status: ["Active", "Idle"], rooms: ["Support"] }, "status", "Idle")).toEqual({
      status: ["Idle"],
      rooms: ["Support"],
    });
  });

  it("clears the column for every value", () => {
    expect(pickOnly({ status: ["Active"], rooms: ["Support"] }, "status", null)).toEqual({ rooms: ["Support"] });
  });
});

describe("pruneSelection", () => {
  it("drops a value no row holds any more, and the column once it has none", () => {
    const remaining = rows.filter((row) => row.id !== 2);
    expect(pruneSelection({ rooms: ["Triage", "Support"], status: ["Idle"] }, columns, remaining)).toEqual({
      rooms: ["Support"],
    });
  });

  it("keeps a value the column's own options offer, whatever the rows hold", () => {
    const fixed: FilterableColumn<Row>[] = [
      { field: "status", filter: { value: (row) => row.status, options: [{ value: "Paused", label: "Paused" }] } },
    ];
    expect(pruneSelection({ status: ["Paused"] }, fixed, rows)).toEqual({ status: ["Paused"] });
  });

  it("drops a pick on a column that is gone or has no filter", () => {
    expect(pruneSelection({ name: ["release-bot"], owner: ["x"] }, columns, rows)).toEqual({});
  });

  it("answers the same selection when nothing is dropped, so a caller can skip the update", () => {
    const selection = { status: ["Active"] };
    expect(pruneSelection(selection, columns, rows)).toBe(selection);
  });
});
