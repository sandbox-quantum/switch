// Shared room filtering for the rooms list and the rooms graph, so both views
// expose the exact same filters and apply them identically.
//
// `useRoomFilterState` owns the filter UI state (and the debounced search +
// `showArchived` flag the page feeds to `useRooms`). `filterRooms` is the pure
// predicate applied to the fetched rooms. `<RoomFilters>` renders the control
// row (search + status + group + owner + bridge + connected user).

import { MenuItem, Stack, TextField } from "@mui/material";
import { useCallback, useMemo, useState } from "react";
import type { RoomGroupDetail, RoomSummary } from "../../data/api";
import { ancestorChain, buildGroupIndex, flattenTree } from "./groupTree";

export interface RoomFilterState {
  search: string;
  setSearch: (value: string) => void;
  // Debounced mirror of `search`, suitable to pass to `useRooms` (which hits
  // the backend `?search=` param).
  debouncedSearch: string;
  statusFilter: "active" | "archived";
  setStatusFilter: (value: "active" | "archived") => void;
  // Whether archived rooms should be fetched (pass to `useRooms`).
  showArchived: boolean;
  groupFilter: string;
  setGroupFilter: (value: string) => void;
  ownerFilter: string;
  setOwnerFilter: (value: string) => void;
  bridgeFilter: string;
  setBridgeFilter: (value: string) => void;
  userFilter: string;
  setUserFilter: (value: string) => void;
}

export function useRoomFilterState(): RoomFilterState {
  const [search, setSearchRaw] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [debounceTimer, setDebounceTimer] = useState<ReturnType<typeof setTimeout>>();
  const [statusFilter, setStatusFilter] = useState<"active" | "archived">("active");
  const [groupFilter, setGroupFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [bridgeFilter, setBridgeFilter] = useState("");
  const [userFilter, setUserFilter] = useState("");

  const setSearch = useCallback(
    (value: string) => {
      setSearchRaw(value);
      if (debounceTimer) clearTimeout(debounceTimer);
      setDebounceTimer(setTimeout(() => setDebouncedSearch(value), 300));
    },
    [debounceTimer],
  );

  return {
    search,
    setSearch,
    debouncedSearch,
    statusFilter,
    setStatusFilter,
    showArchived: statusFilter === "archived",
    groupFilter,
    setGroupFilter,
    ownerFilter,
    setOwnerFilter,
    bridgeFilter,
    setBridgeFilter,
    userFilter,
    setUserFilter,
  };
}

/**
 * Apply the active filters to a set of rooms. Search is handled server-side
 * (via `useRooms(debouncedSearch, …)`), so it is not re-applied here.
 */
export function filterRooms(
  rooms: RoomSummary[],
  groups: RoomGroupDetail[],
  state: RoomFilterState,
): RoomSummary[] {
  const byId = buildGroupIndex(groups);
  // Filtering on a group also includes every room in its sub-tree.
  const groupBranch = state.groupFilter
    ? new Set(
        groups
          .filter((g) =>
            ancestorChain(g.id, byId).some((a) => a.id === state.groupFilter),
          )
          .map((g) => g.id),
      )
    : null;

  let result = rooms.filter((r) => r.archived === state.showArchived);
  if (state.bridgeFilter) {
    result = result.filter((r) => r.bridge_display_name === state.bridgeFilter);
  }
  if (state.userFilter) {
    result = result.filter((r) => r.connected_user_names.includes(state.userFilter));
  }
  if (groupBranch) {
    result = result.filter((r) => r.group_id && groupBranch.has(r.group_id));
  }
  if (state.ownerFilter) {
    result = result.filter((r) => r.owner_id === state.ownerFilter);
  }
  return result;
}

export function RoomFilters({
  rooms,
  groups,
  state,
}: {
  rooms: RoomSummary[];
  groups: RoomGroupDetail[];
  state: RoomFilterState;
}) {
  const bridgeNames = useMemo(() => {
    const names = new Set<string>();
    for (const room of rooms) {
      if (room.bridge_display_name) names.add(room.bridge_display_name);
    }
    return [...names].sort();
  }, [rooms]);

  const connectedUserNames = useMemo(() => {
    const names = new Set<string>();
    for (const room of rooms) {
      for (const name of room.connected_user_names) names.add(name);
    }
    return [...names].sort();
  }, [rooms]);

  // Distinct room owners, keyed by id so display names can collide safely.
  const ownerOptions = useMemo(() => {
    const byOwnerId = new Map<string, string>();
    for (const room of rooms) {
      if (room.owner_id) byOwnerId.set(room.owner_id, room.owner_name ?? room.owner_id);
    }
    return [...byOwnerId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rooms]);

  return (
    <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
      <TextField
        size="small"
        placeholder="Search rooms..."
        value={state.search}
        onChange={(e) => state.setSearch(e.target.value)}
        sx={{ width: 300 }}
      />
      <TextField
        size="small"
        select
        label="Status"
        value={state.statusFilter}
        onChange={(e) => state.setStatusFilter(e.target.value as "active" | "archived")}
        sx={{ width: 140 }}
      >
        <MenuItem value="active">Active</MenuItem>
        <MenuItem value="archived">Archived</MenuItem>
      </TextField>
      {groups.length > 0 && (
        <TextField
          size="small"
          select
          label="Group"
          value={state.groupFilter}
          onChange={(e) => state.setGroupFilter(e.target.value)}
          sx={{ width: 220 }}
        >
          <MenuItem value="">All</MenuItem>
          {flattenTree(groups).map(({ group, depth }) => (
            <MenuItem key={group.id} value={group.id}>
              {"  ".repeat(depth)}
              {group.name}
            </MenuItem>
          ))}
        </TextField>
      )}
      {ownerOptions.length > 0 && (
        <TextField
          size="small"
          select
          label="Owner"
          value={state.ownerFilter}
          onChange={(e) => state.setOwnerFilter(e.target.value)}
          sx={{ width: 200 }}
        >
          <MenuItem value="">All</MenuItem>
          {ownerOptions.map((owner) => (
            <MenuItem key={owner.id} value={owner.id}>
              {owner.name}
            </MenuItem>
          ))}
        </TextField>
      )}
      {bridgeNames.length > 0 && (
        <TextField
          size="small"
          select
          label="Bridge"
          value={state.bridgeFilter}
          onChange={(e) => state.setBridgeFilter(e.target.value)}
          sx={{ width: 200 }}
        >
          <MenuItem value="">All</MenuItem>
          {bridgeNames.map((name) => (
            <MenuItem key={name} value={name}>
              {name}
            </MenuItem>
          ))}
        </TextField>
      )}
      {connectedUserNames.length > 0 && (
        <TextField
          size="small"
          select
          label="Connected user"
          value={state.userFilter}
          onChange={(e) => state.setUserFilter(e.target.value)}
          sx={{ width: 200 }}
        >
          <MenuItem value="">All</MenuItem>
          {connectedUserNames.map((name) => (
            <MenuItem key={name} value={name}>
              {name}
            </MenuItem>
          ))}
        </TextField>
      )}
    </Stack>
  );
}
