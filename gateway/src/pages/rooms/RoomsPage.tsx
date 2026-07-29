import AddIcon from "@mui/icons-material/Add";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import ArchiveOutlined from "@mui/icons-material/ArchiveOutlined";
import FolderOutlined from "@mui/icons-material/FolderOutlined";
import UnarchiveOutlined from "@mui/icons-material/UnarchiveOutlined";
import { Box, Button, Chip, CircularProgress, Stack, Typography } from "@mui/material";
import type { GridColDef, GridRowId } from "@mui/x-data-grid";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { AccessChip } from "../../components/AccessControls";
import DataTable from "../../components/DataTable";
import {
  type RoomSummary,
  archiveRoom,
  bulkArchiveRooms,
  unarchiveRoom,
} from "../../data/api";
import { useRoomGroups, useRooms } from "../../data/hooks";
import { EM_DASH, MONO_SX, channelTypeLabel, formatDate } from "../../theme/hootFormat";
import { buildGroupIndex, effectiveColor, groupPathName } from "./groupTree";
import { RoomFilters, filterRooms, useRoomFilterState } from "./roomFilters";

function Missing() {
  return (
    <Typography component="span" variant="body2" sx={{ color: "text.secondary" }}>
      {EM_DASH}
    </Typography>
  );
}

function ColorDot({ color }: { color: string }) {
  return (
    <Box
      sx={{
        width: 10,
        height: 10,
        borderRadius: "50%",
        bgcolor: color,
        flexShrink: 0,
      }}
    />
  );
}

export default function RoomsPage() {
  const navigate = useNavigate();
  const filters = useRoomFilterState();
  const [selected, setSelected] = useState<GridRowId[]>([]);
  const [busy, setBusy] = useState(false);

  const { data: rooms, loading, refetch } = useRooms(
    filters.debouncedSearch || undefined,
    filters.showArchived,
  );
  const { data: groups } = useRoomGroups();

  const groupList = useMemo(() => groups ?? [], [groups]);
  const byId = useMemo(() => buildGroupIndex(groupList), [groupList]);
  // In the "Archived" view the actions flip from archive → unarchive.
  const viewingArchived = filters.showArchived;

  const filteredRooms = useMemo(
    () => filterRooms(rooms ?? [], groupList, filters),
    [
      rooms,
      groupList,
      filters.showArchived,
      filters.bridgeFilter,
      filters.userFilter,
      filters.groupFilter,
      filters.ownerFilter,
    ],
  );

  const handleToggleArchive = useCallback(
    async (roomId: string, archived: boolean) => {
      if (archived) {
        await unarchiveRoom(roomId);
      } else {
        await archiveRoom(roomId);
      }
      refetch();
    },
    [refetch],
  );

  const handleBulkArchive = useCallback(async () => {
    setBusy(true);
    const ids = selected.map(String);
    // Active view → archive the selection; Archived view → unarchive it.
    await bulkArchiveRooms(ids, !viewingArchived);
    setSelected([]);
    setBusy(false);
    refetch();
  }, [selected, viewingArchived, refetch]);

  const columns = useMemo<GridColDef<RoomSummary>[]>(
    () => [
      { field: "name", headerName: "Name", flex: 1, minWidth: 160 },
      {
        field: "group_id",
        headerName: "Group",
        flex: 1,
        minWidth: 160,
        valueGetter: (_value, row) =>
          row.group_id ? groupPathName(row.group_id, byId) : "",
        renderCell: ({ row }) =>
          row.group_id ? (
            <Stack direction="row" alignItems="center" spacing={1}>
              <ColorDot color={effectiveColor(row.group_id, byId)} />
              <span>{groupPathName(row.group_id, byId) || row.group_name}</span>
            </Stack>
          ) : (
            <Missing />
          ),
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
      },
      {
        field: "read_visibility",
        headerName: "Access",
        width: 108,
        renderCell: ({ row }) => <AccessChip pair={row} />,
      },
      {
        field: "channel_type",
        headerName: "Type",
        width: 150,
        renderCell: ({ value }) =>
          value ? (
            <Chip label={channelTypeLabel(value as string)} size="small" />
          ) : (
            <Missing />
          ),
      },
      { field: "agent_count", headerName: "Agents", width: 84, type: "number" },
      {
        field: "connected_user_count",
        headerName: "Users",
        width: 84,
        type: "number",
      },
      {
        field: "bridge_display_name",
        headerName: "Bridge",
        width: 130,
        renderCell: ({ value }) =>
          value ? (
            <Chip label={value} size="small" />
          ) : (
            <Missing />
          ),
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
        width: 116,
        sortable: false,
        filterable: false,
        renderCell: ({ row }) => (
          <Button
            size="small"
            color="inherit"
            startIcon={
              row.archived ? (
                <UnarchiveOutlined fontSize="small" />
              ) : (
                <ArchiveOutlined fontSize="small" />
              )
            }
            onClick={(e) => {
              e.stopPropagation();
              handleToggleArchive(row.id, row.archived);
            }}
          >
            {row.archived ? "Unarchive" : "Archive"}
          </Button>
        ),
      },
    ],
    [handleToggleArchive, byId],
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}>
        <Typography variant="h5">Rooms</Typography>
        <Stack direction="row" spacing={1}>
          {selected.length > 0 && (
            <Button
              variant="outlined"
              startIcon={
                viewingArchived ? <UnarchiveOutlined /> : <ArchiveOutlined />
              }
              onClick={handleBulkArchive}
              disabled={busy}
            >
              {viewingArchived ? "Unarchive" : "Archive"} ({selected.length})
            </Button>
          )}
          <Button
            variant="outlined"
            startIcon={<FolderOutlined />}
            onClick={() => navigate("/rooms/groups")}
          >
            Manage groups
          </Button>
          <Button
            variant="outlined"
            startIcon={<AccountTreeIcon />}
            onClick={() => navigate("/rooms/graph")}
          >
            Graph view
          </Button>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => navigate("/rooms/new")}
          >
            New room
          </Button>
        </Stack>
      </Stack>

      <RoomFilters rooms={rooms ?? []} groups={groupList} state={filters} />

      {loading ? (
        <CircularProgress />
      ) : (
        <DataTable
          rows={filteredRooms}
          columns={columns}
          fillHeight
          checkboxSelection
          onRowSelectionModelChange={setSelected}
          onRowClick={(params) => navigate(`/rooms/${params.id}`)}
          sx={{ "& .MuiDataGrid-row": { cursor: "pointer" } }}
        />
      )}

    </Box>
  );
}
