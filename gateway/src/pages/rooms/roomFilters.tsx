// Room filtering shared by the rooms list and the rooms graph, so both views
// offer the same filters and apply them identically. The list puts them in
// its table's column headers; the graph, which has no table, renders them as
// `<RoomFilters>`. Both read a room's values through the functions here.

import { MenuItem, Stack, TextField } from "@mui/material";
import { useMemo, useState } from "react";
import type { FilterOption } from "../../components/tableFilters";
import type { RoomGroupDetail, RoomSummary } from "../../data/api";
import { ancestorChain, flattenTree, groupPathName } from "./groupTree";

/** Filter values for a room with no group, owner or bridge. Not ids, so they
 * cannot collide with one. */
export const NO_GROUP = "none:group";
export const NO_OWNER = "none:owner";
export const NOT_BRIDGED = "none:bridge";

type GroupIndex = Map<string, RoomGroupDetail>;

/** The groups a room counts as in: its own and every group above it, so
 * picking a group also picks the rooms in its sub-groups. A group missing
 * from the index (the tree failed to load) counts as itself alone. */
export function roomGroupValues(room: RoomSummary, byId: GroupIndex): string[] {
  if (!room.group_id) return [NO_GROUP];
  const chain = ancestorChain(room.group_id, byId).map((g) => g.id);
  return chain.length > 0 ? chain : [room.group_id];
}

export function roomOwnerValue(room: RoomSummary): string {
  return room.owner_id ?? NO_OWNER;
}

export function roomBridgeValue(room: RoomSummary): string {
  return room.bridge_display_name ?? NOT_BRIDGED;
}

/** A room's group as people read it: the path from the top group down, or
 * the room's own group name while the tree is unavailable. */
export function roomGroupLabel(room: RoomSummary, byId: GroupIndex): string {
  if (!room.group_id) return "";
  return groupPathName(room.group_id, byId) || (room.group_name ?? "");
}

/** What a search matches: the room's name and description, as the server's
 * own search does, plus what the list shows of its group, owner and bridge. */
export function roomSearchText(room: RoomSummary, byId: GroupIndex): string {
  return [
    room.name,
    room.description,
    roomGroupLabel(room, byId),
    room.owner_name ?? "",
    room.bridge_display_name ?? "",
  ].join("\n");
}

/** The groups on offer: every group in the tree, as its path, top groups
 * first; or, while the tree is unavailable, the groups the rooms name. */
export function groupOptions(
  groups: RoomGroupDetail[],
  byId: GroupIndex,
  rooms: readonly RoomSummary[],
): FilterOption[] {
  const named =
    groups.length > 0
      ? flattenTree(groups).map(({ group }) => ({
          value: group.id,
          label: groupPathName(group.id, byId),
        }))
      : distinct(
          rooms.flatMap((r) => (r.group_id ? [{ value: r.group_id, label: r.group_name ?? r.group_id }] : [])),
        );
  return [{ value: NO_GROUP, label: "No group" }, ...named];
}

/** The owners of these rooms, keyed by id so two people of the same name
 * stay apart. */
export function ownerOptions(rooms: readonly RoomSummary[]): FilterOption[] {
  const owners = distinct(
    rooms.flatMap((r) => (r.owner_id ? [{ value: r.owner_id, label: r.owner_name ?? r.owner_id }] : [])),
  );
  const unowned = rooms.some((r) => !r.owner_id) ? [{ value: NO_OWNER, label: "No owner" }] : [];
  return [...unowned, ...owners];
}

export function bridgeOptions(rooms: readonly RoomSummary[]): FilterOption[] {
  const bridges = distinct(
    rooms.flatMap((r) =>
      r.bridge_display_name ? [{ value: r.bridge_display_name, label: r.bridge_display_name }] : [],
    ),
  );
  return [{ value: NOT_BRIDGED, label: "Not bridged" }, ...bridges];
}

export function connectedUserOptions(rooms: readonly RoomSummary[]): FilterOption[] {
  return distinct(rooms.flatMap((r) => r.connected_user_names.map((name) => ({ value: name, label: name }))));
}

function distinct(options: FilterOption[]): FilterOption[] {
  const byValue = new Map(options.map((o) => [o.value, o]));
  return [...byValue.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export interface RoomFilterState {
  search: string;
  setSearch: (value: string) => void;
  showArchived: boolean;
  setShowArchived: (value: boolean) => void;
  group: string;
  setGroup: (value: string) => void;
  owner: string;
  setOwner: (value: string) => void;
  bridge: string;
  setBridge: (value: string) => void;
  user: string;
  setUser: (value: string) => void;
}

export function useRoomFilterState(): RoomFilterState {
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [group, setGroup] = useState("");
  const [owner, setOwner] = useState("");
  const [bridge, setBridge] = useState("");
  const [user, setUser] = useState("");
  return {
    search,
    setSearch,
    showArchived,
    setShowArchived,
    group,
    setGroup,
    owner,
    setOwner,
    bridge,
    setBridge,
    user,
    setUser,
  };
}

/** The rooms that pass the graph's filters, by the same values the list's
 * column filters read. */
export function filterRooms(
  rooms: readonly RoomSummary[],
  byId: GroupIndex,
  state: RoomFilterState,
): RoomSummary[] {
  const needle = state.search.trim().toLocaleLowerCase();
  return rooms.filter(
    (r) =>
      r.archived === state.showArchived &&
      (!needle || roomSearchText(r, byId).toLocaleLowerCase().includes(needle)) &&
      (!state.group || roomGroupValues(r, byId).includes(state.group)) &&
      (!state.owner || roomOwnerValue(r) === state.owner) &&
      (!state.bridge || roomBridgeValue(r) === state.bridge) &&
      (!state.user || r.connected_user_names.includes(state.user)),
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
}) {
  return (
    <TextField select label={label} value={value} onChange={(e) => onChange(e.target.value)} sx={{ width: 200 }}>
      <MenuItem value="">All</MenuItem>
      {options.map((option) => (
        <MenuItem key={option.value} value={option.value}>
          {option.label}
        </MenuItem>
      ))}
    </TextField>
  );
}

export function RoomFilters({
  rooms,
  groups,
  byId,
  state,
}: {
  rooms: readonly RoomSummary[];
  groups: RoomGroupDetail[];
  byId: GroupIndex;
  state: RoomFilterState;
}) {
  const options = useMemo(
    () => ({
      group: groupOptions(groups, byId, rooms),
      owner: ownerOptions(rooms),
      bridge: bridgeOptions(rooms),
      user: connectedUserOptions(rooms),
    }),
    [groups, byId, rooms],
  );

  return (
    <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mb: 2, alignItems: "flex-end" }}>
      <TextField
        label="Search rooms"
        value={state.search}
        onChange={(e) => state.setSearch(e.target.value)}
        sx={{ width: 300 }}
      />
      <TextField
        select
        label="Status"
        value={state.showArchived ? "archived" : "active"}
        onChange={(e) => state.setShowArchived(e.target.value === "archived")}
        sx={{ width: 140 }}
      >
        <MenuItem value="active">Active</MenuItem>
        <MenuItem value="archived">Archived</MenuItem>
      </TextField>
      <FilterSelect label="Group" value={state.group} onChange={state.setGroup} options={options.group} />
      <FilterSelect label="Owner" value={state.owner} onChange={state.setOwner} options={options.owner} />
      <FilterSelect label="Bridge" value={state.bridge} onChange={state.setBridge} options={options.bridge} />
      {options.user.length > 0 && (
        <FilterSelect label="Connected user" value={state.user} onChange={state.setUser} options={options.user} />
      )}
    </Stack>
  );
}
