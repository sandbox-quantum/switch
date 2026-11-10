import { describe, expect, it } from "vitest";
import type { RoomGroupDetail, RoomSummary } from "../../data/api";
import { buildGroupIndex } from "./groupTree";
import {
  NO_GROUP,
  NO_OWNER,
  NOT_BRIDGED,
  bridgeOptions,
  filterRooms,
  groupOptions,
  ownerOptions,
  roomBridgeValue,
  roomGroupValues,
  roomSearchText,
  type RoomFilterState,
} from "./roomFilters";

const group = (id: string, name: string, parent: string | null) =>
  ({ id, name, parent_group_id: parent, color: null }) as unknown as RoomGroupDetail;

const GROUPS = [group("eng", "Engineering", null), group("be", "Backend", "eng")];
const byId = buildGroupIndex(GROUPS);

const room = (id: string, overrides: Partial<RoomSummary>) =>
  ({
    id,
    name: id,
    description: "",
    group_id: null,
    group_name: null,
    owner_id: null,
    owner_name: null,
    bridge_display_name: null,
    connected_user_names: [],
    archived: false,
    ...overrides,
  }) as RoomSummary;

const state = (overrides: Partial<RoomFilterState>) =>
  ({
    search: "",
    showArchived: false,
    group: "",
    owner: "",
    bridge: "",
    user: "",
    ...overrides,
  }) as RoomFilterState;

describe("room filter values", () => {
  it("counts a room in a sub-group as in every group above it", () => {
    expect(roomGroupValues(room("r", { group_id: "be" }), byId)).toEqual(["eng", "be"]);
    expect(roomGroupValues(room("r", {}), byId)).toEqual([NO_GROUP]);
  });

  it("counts a room as in its own group alone when the tree is unavailable", () => {
    expect(roomGroupValues(room("r", { group_id: "be" }), new Map())).toEqual(["be"]);
  });

  it("gives a room with no bridge its own value", () => {
    expect(roomBridgeValue(room("r", {}))).toBe(NOT_BRIDGED);
    expect(roomBridgeValue(room("r", { bridge_display_name: "Slack" }))).toBe("Slack");
  });

  it("searches the description as the server's search does, and the group path", () => {
    const text = roomSearchText(room("r", { description: "Release triage", group_id: "be" }), byId);
    expect(text).toContain("Release triage");
    expect(text).toContain("Engineering / Backend");
  });
});

describe("room filter options", () => {
  it("offers every group as its path, after No group", () => {
    expect(groupOptions(GROUPS, byId, [])).toEqual([
      { value: NO_GROUP, label: "No group" },
      { value: "eng", label: "Engineering" },
      { value: "be", label: "Engineering / Backend" },
    ]);
  });

  it("keys owners by id, and offers No owner only when a room has none", () => {
    const rooms = [
      room("a", { owner_id: "u1", owner_name: "Sam" }),
      room("b", { owner_id: "u2", owner_name: "Sam" }),
    ];
    expect(ownerOptions(rooms).map((o) => o.value)).toEqual(["u1", "u2"]);
    expect(ownerOptions([...rooms, room("c", {})])[0]).toEqual({ value: NO_OWNER, label: "No owner" });
  });

  it("offers Not bridged first, then each bridge once", () => {
    const rooms = [room("a", { bridge_display_name: "Slack" }), room("b", { bridge_display_name: "Slack" })];
    expect(bridgeOptions(rooms)).toEqual([
      { value: NOT_BRIDGED, label: "Not bridged" },
      { value: "Slack", label: "Slack" },
    ]);
  });
});

describe("filterRooms (the graph's filters)", () => {
  const rooms = [
    room("api", { group_id: "be", bridge_display_name: "Slack", description: "Backend API" }),
    room("lobby", {}),
    room("old", { archived: true }),
  ];
  const names = (s: RoomFilterState) => filterRooms(rooms, byId, s).map((r) => r.id);

  it("shows active or archived rooms, never both", () => {
    expect(names(state({}))).toEqual(["api", "lobby"]);
    expect(names(state({ showArchived: true }))).toEqual(["old"]);
  });

  it("filters by the same values as the list's columns", () => {
    expect(names(state({ group: "eng" }))).toEqual(["api"]);
    expect(names(state({ group: NO_GROUP }))).toEqual(["lobby"]);
    expect(names(state({ bridge: NOT_BRIDGED }))).toEqual(["lobby"]);
    expect(names(state({ search: "backend" }))).toEqual(["api"]);
  });
});
