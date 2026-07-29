import { Alert, Box, CircularProgress } from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid-pro";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import DataTable from "../../components/DataTable";
import { AccessChip } from "../../components/AccessControls";
import type { DocumentSummary } from "../../data/api";
import { useDocuments } from "../../data/hooks";
import ResourceFiltersBar from "./ResourceFiltersBar";
import { formatDate } from "../../theme/hootFormat";

interface Props {
  refreshKey: number;
}

export default function DocumentsTab({ refreshKey }: Props) {
  const navigate = useNavigate();
  const { data: docs, loading, error, refetch } = useDocuments();
  const [search, setSearch] = useState("");
  const [ownerId, setOwnerId] = useState<string>("");

  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const owners = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of docs ?? []) {
      if (d.owner_id) m.set(d.owner_id, d.owner_name ?? d.owner_id);
    }
    return [...m.entries()].map(([id, name]) => ({ id, name }));
  }, [docs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (docs ?? []).filter((d) => {
      if (ownerId && d.owner_id !== ownerId) return false;
      if (q && !d.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [docs, search, ownerId]);

  const columns = useMemo<GridColDef<DocumentSummary>[]>(
    () => [
      { field: "name", headerName: "Name", flex: 1, minWidth: 180 },
      { field: "description", headerName: "Description", flex: 2, minWidth: 280 },
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
        renderCell: ({ value, row }) => value ?? row.owner_id ?? "—",
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
    [],
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <ResourceFiltersBar
        search={search}
        onSearchChange={setSearch}
        ownerId={ownerId}
        onOwnerChange={setOwnerId}
        owners={owners}
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
            navigate(`/resources/documents/${params.id}`)
          }
          sx={{ "& .MuiDataGrid-row": { cursor: "pointer" } }}
        />
      )}
    </Box>
  );
}
