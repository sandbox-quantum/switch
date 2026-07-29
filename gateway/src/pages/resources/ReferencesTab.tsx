import { Alert, Box, Chip, CircularProgress } from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import DataTable from "../../components/DataTable";
import { AccessChip } from "../../components/AccessControls";
import type { ReferenceDetail } from "../../data/api";
import { useReferences, useReferenceTypes } from "../../data/hooks";
import ResourceFiltersBar from "./ResourceFiltersBar";
import { formatDate } from "../../theme/hootFormat";

interface Props {
  refreshKey: number;
}

export default function ReferencesTab({ refreshKey }: Props) {
  const navigate = useNavigate();
  const { data: refs, loading, error, refetch } = useReferences();
  const { data: types } = useReferenceTypes();
  const [search, setSearch] = useState("");
  const [ownerId, setOwnerId] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("");

  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const displayNameByType = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of types ?? []) m[t.type] = t.display_name;
    return m;
  }, [types]);

  const owners = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of refs ?? []) {
      m.set(r.owner_id, r.owner_name ?? r.owner_id);
    }
    return [...m.entries()].map(([id, name]) => ({ id, name }));
  }, [refs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (refs ?? []).filter((r) => {
      if (ownerId && r.owner_id !== ownerId) return false;
      if (typeFilter && r.type !== typeFilter) return false;
      if (q && !r.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [refs, search, ownerId, typeFilter]);

  const columns = useMemo<GridColDef<ReferenceDetail>[]>(
    () => [
      { field: "name", headerName: "Name", flex: 1, minWidth: 180 },
      {
        field: "type",
        headerName: "Type",
        width: 150,
        renderCell: ({ value }) => (
          <Chip label={displayNameByType[value] ?? value} size="small" />
        ),
      },
      { field: "description", headerName: "Description", flex: 2, minWidth: 240 },
      {
        field: "read_visibility",
        headerName: "Access",
        width: 110,
        renderCell: ({ row }) => <AccessChip pair={row} />,
      },
      {
        field: "owner_name",
        headerName: "Owner",
        width: 150,
        renderCell: ({ value, row }) => value ?? row.owner_id,
      },
      {
        field: "attached_rooms_count",
        headerName: "Rooms",
        width: 90,
        type: "number",
      },
      {
        field: "created_at",
        headerName: "Created",
        width: 116,
        valueFormatter: (value) => formatDate(value as string),
      },
    ],
    [displayNameByType],
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <ResourceFiltersBar
        search={search}
        onSearchChange={setSearch}
        ownerId={ownerId}
        onOwnerChange={setOwnerId}
        owners={owners}
        typeFilter={typeFilter}
        onTypeChange={setTypeFilter}
        types={(types ?? []).map((t) => ({ value: t.type, label: t.display_name }))}
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <CircularProgress />
      ) : (
        <DataTable
          rows={filtered}
          columns={columns}
          fillHeight
          onRowClick={(params) =>
            navigate(`/resources/references/${params.id}`)
          }
          sx={{ "& .MuiDataGrid-row": { cursor: "pointer" } }}
        />
      )}
    </Box>
  );
}
