import AddIcon from "@mui/icons-material/Add";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import ArchiveOutlined from "@mui/icons-material/ArchiveOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import FolderOutlined from "@mui/icons-material/FolderOutlined";
import UnarchiveOutlined from "@mui/icons-material/UnarchiveOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import type { GridRowId } from "@mui/x-data-grid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import ConfirmDialog from "../../components/ConfirmDialog";
import DataTable, { type TableColumn, TableEmptyState } from "../../components/DataTable";
import RowActionsMenu, { type RowAction } from "../../components/RowActionsMenu";
import { useAuth } from "../../data/AuthContext";
import {
  type RoomSummary,
  archiveRoom,
  bulkArchiveRooms,
  deleteRoom,
  loadRoomsWithArchived,
  unarchiveRoom,
} from "../../data/api";
import { GATEWAY_V2 } from "../../data/featureFlags";
import { useRoomGroups } from "../../data/hooks";
import { type ListScope, listScopeOf, roomsInScope } from "../../data/listScope";
import { EM_DASH, MONO_SX, channelTypeLabel, formatDate } from "../../theme/format";
import { useLoad } from "../workspace/useLoad";
import { buildGroupIndex, effectiveColor } from "./groupTree";
import { RoomAccessChip } from "./RoomAccessChip";
import {
  bridgeOptions,
  connectedUserOptions,
  groupOptions,
  ownerOptions,
  roomBridgeValue,
  roomGroupLabel,
  roomGroupValues,
  roomOwnerValue,
  roomSearchText,
} from "./roomFilters";

const NOUN = { one: "room", other: "rooms" };

type View = "active" | "archived";

/** What the confirm dialog is asking about. */
type Pending = { kind: "archive"; rooms: RoomSummary[] } | { kind: "delete"; room: RoomSummary };

/** A notice another page leaves for this one when it sends someone here,
 * such as a room's platform channel that could not be cleaned up. */
export interface RoomsNotice {
  notice: string;
}

function Missing() {
  return (
    <Typography component="span" variant="body2" sx={{ color: "text.secondary" }}>
      {EM_DASH}
    </Typography>
  );
}

function ColorDot({ color }: { color: string }) {
  return <Box sx={{ width: 10, height: 10, borderRadius: "50%", bgcolor: color, flexShrink: 0 }} />;
}

const newestFirst = (rooms: readonly RoomSummary[]) =>
  [...rooms].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}

/** Archive confirms first; it hides the room from everyone's active list. */
function ArchiveDescription({ rooms }: { rooms: RoomSummary[] }) {
  const one = rooms.length === 1;
  return (
    <>
      {one ? "Archiving hides it" : "Archiving hides them"} from the active room list.{" "}
      {one ? "Its" : "Their"} messages, people and any linked channel are untouched, and you can unarchive{" "}
      {one ? "it" : "them"} at any time.
    </>
  );
}

function DeleteDescription({ room }: { room: RoomSummary }) {
  return (
    <>
      This removes the room and takes everyone out of it. This cannot be undone.
      {room.bridge_display_name && (
        <>
          {" "}
          Its {room.bridge_display_name} channel is kept; to remove the channel too, delete the room from its page.
        </>
      )}
    </>
  );
}

export default function RoomsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { session, capabilities } = useAuth();
  const rooms = useLoad(loadRoomsWithArchived);
  const refetchRooms = rooms.refetch;
  const groups = useRoomGroups();
  const [view, setView] = useState<View>("active");
  const [selected, setSelected] = useState<GridRowId[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [notice, setNotice] = useState<{ severity: "error" | "warning"; text: string } | null>(() => {
    const passed = (location.state as RoomsNotice | null)?.notice;
    return passed ? { severity: "warning", text: passed } : null;
  });

  // Only the new layout narrows a member's list to their own rooms, as its
  // Overview counts them; today's layout keeps showing every room they may
  // read. Narrowing is a view, not a permission.
  const scope: ListScope = capabilities.features[GATEWAY_V2] ? listScopeOf(capabilities) : "workspace";
  const workspace = session?.tenant?.name ?? "this workspace";

  const groupList = useMemo(() => groups.data ?? [], [groups.data]);
  const byId = useMemo(() => buildGroupIndex(groupList), [groupList]);

  // The notice was for arriving here; reloading the page should not repeat it.
  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate]);

  // What the viewer may do with each room is the server's answer for their
  // role, so a role that changes while the page is open (the session is read
  // again when the tab comes back) reads the rooms again.
  const administers = capabilities.administersWorkspace;
  const loadedAs = useRef(administers);
  useEffect(() => {
    if (loadedAs.current === administers) return;
    loadedAs.current = administers;
    void refetchRooms();
  }, [administers, refetchRooms]);

  const { visible, active, archived } = useMemo(() => {
    const all = newestFirst(roomsInScope(rooms.data ?? [], scope));
    return { visible: all, active: all.filter((r) => !r.archived), archived: all.filter((r) => r.archived) };
  }, [rooms.data, scope]);
  const rows = view === "archived" ? archived : active;
  // A room archived, unarchived or deleted leaves this view's rows, and with
  // them the selection.
  const selectedRooms = useMemo(() => rows.filter((r) => selected.includes(r.id)), [rows, selected]);

  const ask = useCallback((next: Pending) => {
    setPending(next);
    setConfirmOpen(true);
  }, []);

  const unarchive = useCallback(
    async (targets: RoomSummary[]) => {
      setNotice(null);
      try {
        if (targets.length === 1) {
          await unarchiveRoom(targets[0].id);
        } else {
          const result = await bulkArchiveRooms(
            targets.map((r) => r.id),
            false,
          );
          if (result.updated < targets.length) {
            setNotice({
              severity: "warning",
              text: `Unarchived ${result.updated} of ${targets.length}; ${targets.length - result.updated} you can't change or no longer exist.`,
            });
          }
        }
      } catch (err) {
        setNotice({
          severity: "error",
          text: `Couldn't unarchive ${targets.length === 1 ? "the room" : "the selected rooms"}: ${errorText(err)}`,
        });
      }
      void refetchRooms();
    },
    [refetchRooms],
  );

  const confirm = useCallback(async () => {
    if (!pending) return;
    setNotice(null);
    if (pending.kind === "delete") {
      await deleteRoom(pending.room.id, false);
    } else if (pending.rooms.length === 1) {
      await archiveRoom(pending.rooms[0].id);
    } else {
      const ids = pending.rooms.map((r) => r.id);
      const result = await bulkArchiveRooms(ids, true);
      // The server skips, without failing, any room the viewer can't change
      // or that is gone, and says how many it did change.
      if (result.updated < ids.length) {
        setNotice({
          severity: "warning",
          text: `Archived ${result.updated} of ${ids.length}; ${ids.length - result.updated} you can't change or no longer exist.`,
        });
      }
    }
    void refetchRooms();
  }, [pending, refetchRooms]);

  // Filters offer what either view holds, so a pick survives switching views.
  const columns = useMemo<TableColumn<RoomSummary>[]>(() => {
    const viewRooms = visible;
    return [
      { field: "name", headerName: "Name", flex: 1, minWidth: 160 },
      {
        field: "group_id",
        headerName: "Group",
        flex: 1,
        minWidth: 160,
        valueGetter: (_value, row) => roomGroupLabel(row, byId),
        renderCell: ({ row }) =>
          row.group_id ? (
            <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0, height: "100%" }}>
              <ColorDot color={effectiveColor(row.group_id, byId)} />
              <Box
                component="span"
                title={roomGroupLabel(row, byId)}
                sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {roomGroupLabel(row, byId)}
              </Box>
            </Stack>
          ) : (
            <Missing />
          ),
        filter: {
          value: (row) => roomGroupValues(row, byId),
          options: groupOptions(groupList, byId, viewRooms),
        },
      },
      {
        field: "owner_name",
        headerName: "Owner",
        flex: 1,
        minWidth: 150,
        renderCell: ({ value, row }) =>
          value ??
          (row.owner_id ? (
            <Typography component="span" sx={MONO_SX}>
              {row.owner_id}
            </Typography>
          ) : (
            <Missing />
          )),
        filter: { value: roomOwnerValue, options: ownerOptions(viewRooms) },
      },
      {
        field: "read_visibility",
        headerName: "Access",
        width: 108,
        renderCell: ({ row }) => <RoomAccessChip room={row} />,
      },
      {
        field: "channel_type",
        headerName: "Type",
        width: 150,
        renderCell: ({ value }) =>
          value ? <Chip label={channelTypeLabel(value as string)} size="small" /> : <Missing />,
      },
      // Counts sit under their headers, left-aligned like every other column,
      // so the Users column's filter button reads as its own.
      { field: "agent_count", headerName: "Agents", width: 84, type: "number", align: "left", headerAlign: "left" },
      {
        field: "connected_user_count",
        headerName: "Users",
        width: 96,
        type: "number",
        align: "left",
        headerAlign: "left",
        // Filtered by who is connected, not by how many.
        filter: { value: (row) => row.connected_user_names, options: connectedUserOptions(viewRooms) },
      },
      {
        field: "bridge_display_name",
        headerName: "Bridge",
        width: 130,
        renderCell: ({ value }) => (value ? <Chip label={value} size="small" /> : <Missing />),
        filter: { value: roomBridgeValue, options: bridgeOptions(viewRooms) },
      },
      {
        field: "created_at",
        headerName: "Created",
        width: 116,
        valueFormatter: (value) => formatDate(value as string),
      },
      {
        field: "actions",
        headerName: "",
        width: 64,
        sortable: false,
        // A header menu's button is wider than the room this column leaves
        // it, and would push the table past its edge.
        disableColumnMenu: true,
        renderCell: ({ row, tabIndex }) => {
          // Archiving takes write access to the room, deleting it managing it.
          const actions: RowAction[] = [];
          if (row.can_write) {
            actions.push(
              row.archived
                ? {
                    label: "Unarchive",
                    icon: <UnarchiveOutlined />,
                    onClick: () => void unarchive([row]),
                  }
                : { label: "Archive", icon: <ArchiveOutlined />, onClick: () => ask({ kind: "archive", rooms: [row] }) },
            );
          }
          if (row.can_manage) {
            actions.push({
              label: "Delete",
              icon: <DeleteOutline />,
              destructive: true,
              onClick: () => ask({ kind: "delete", room: row }),
            });
          }
          return <RowActionsMenu label={`Actions for ${row.name}`} actions={actions} tabIndex={tabIndex} />;
        },
      },
    ];
  }, [visible, byId, groupList, unarchive, ask]);

  const search = useMemo(
    () => ({ label: "Search rooms", text: (row: RoomSummary) => roomSearchText(row, byId) }),
    [byId],
  );

  const newRoom = (
    <Button variant="contained" startIcon={<AddIcon />} onClick={() => navigate("/rooms/new")}>
      New room
    </Button>
  );

  const emptyState =
    view === "archived" ? (
      <TableEmptyState title="No archived rooms">Rooms you archive are listed here.</TableEmptyState>
    ) : (
      <Stack spacing={2} sx={{ alignItems: "center" }}>
        {capabilities.administersWorkspace ? (
          <TableEmptyState title={`No rooms in ${workspace} yet`}>
            Create a room to give people and agents somewhere to work together.
          </TableEmptyState>
        ) : (
          <TableEmptyState title={`You're not in any rooms in ${workspace} yet`}>
            Create a room of your own, or ask a workspace admin to add you to one.
          </TableEmptyState>
        )}
        {newRoom}
      </Stack>
    );

  const viewingArchived = view === "archived";
  const tabLabel = (label: string, count: number) => (
    <span>
      {label}{" "}
      <Box component="span" sx={{ ml: 0.25, color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
        {count}
      </Box>
    </span>
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={2} mb={2}>
        <Box>
          <Typography variant="h5">Rooms</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {scope === "yours"
              ? `Rooms in ${workspace} that you own, are in, or have an agent in.`
              : `Rooms in ${workspace}.`}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
          {selectedRooms.length > 0 && (
            <Button
              variant="outlined"
              startIcon={viewingArchived ? <UnarchiveOutlined /> : <ArchiveOutlined />}
              onClick={() =>
                viewingArchived ? void unarchive(selectedRooms) : ask({ kind: "archive", rooms: selectedRooms })
              }
            >
              {viewingArchived ? "Unarchive" : "Archive"} ({selectedRooms.length})
            </Button>
          )}
          <Button variant="outlined" startIcon={<FolderOutlined />} onClick={() => navigate("/rooms/groups")}>
            Manage groups
          </Button>
          <Button variant="outlined" startIcon={<AccountTreeIcon />} onClick={() => navigate("/rooms/graph")}>
            Graph view
          </Button>
          {newRoom}
        </Stack>
      </Stack>

      {notice && (
        <Alert severity={notice.severity} onClose={() => setNotice(null)} sx={{ mb: 2 }}>
          {notice.text}
        </Alert>
      )}
      {groups.error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Couldn't load the room groups, so rooms show their own group's name only and sub-groups aren't
          filtered together.
        </Alert>
      )}
      {rooms.error && rooms.data && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Couldn't refresh the rooms: {rooms.error}. The list may be out of date.
        </Alert>
      )}

      {rooms.loading ? (
        <CircularProgress />
      ) : rooms.data === null ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void refetchRooms()}>
              Try again
            </Button>
          }
        >
          Couldn't load the rooms: {rooms.error}
        </Alert>
      ) : (
        <>
          <Tabs
            value={view}
            onChange={(_, next: View) => {
              setView(next);
              setSelected([]);
            }}
            sx={{ mb: 2, borderBottom: 1, borderColor: "divider" }}
          >
            <Tab value="active" label={tabLabel("Active", active.length)} />
            <Tab value="archived" label={tabLabel("Archived", archived.length)} />
          </Tabs>
          <DataTable
            rows={rows}
            columns={columns}
            fillHeight
            noun={NOUN}
            search={search}
            pinnedRight={["actions"]}
            emptyState={emptyState}
            checkboxSelection
            isRowSelectable={(room) => room.can_write}
            onRowSelectionModelChange={setSelected}
            onRowClick={(params) => navigate(`/rooms/${params.id}`)}
            sx={{ "& .MuiDataGrid-row": { cursor: "pointer" } }}
          />
        </>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={confirm}
        {...(pending?.kind === "delete"
          ? {
              title: `Delete ${pending.room.name}?`,
              description: <DeleteDescription room={pending.room} />,
              confirmLabel: "Delete room",
              tone: "destructive" as const,
            }
          : {
              title:
                pending && pending.rooms.length > 1 ? `Archive ${pending.rooms.length} rooms?` : `Archive ${pending?.rooms[0]?.name ?? "room"}?`,
              description: <ArchiveDescription rooms={pending?.rooms ?? []} />,
              confirmLabel: pending && pending.rooms.length > 1 ? "Archive rooms" : "Archive room",
              tone: "plain" as const,
            })}
      />
    </Box>
  );
}
