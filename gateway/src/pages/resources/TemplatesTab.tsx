import { Alert, Box, Chip, CircularProgress } from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import DataTable from "../../components/DataTable";
import type { TemplateSummary } from "../../data/api";
import { useTemplates } from "../../data/hooks";
import ResourceFiltersBar from "./ResourceFiltersBar";
import { formatBytes } from "./templateFormat";
import { formatDate } from "../../theme/hootFormat";

interface Props {
  refreshKey: number;
}

export default function TemplatesTab({ refreshKey }: Props) {
  const navigate = useNavigate();
  const { data: templates, loading, error, refetch } = useTemplates();
  const [search, setSearch] = useState("");
  const [ownerId, setOwnerId] = useState<string>("");
  const [kind, setKind] = useState<string>("");

  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const owners = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of templates ?? []) {
      m.set(t.owner_id, t.owner_name ?? t.owner_id);
    }
    return [...m.entries()].map(([id, name]) => ({ id, name }));
  }, [templates]);

  // Kinds are free text on the server, so the filter offers whatever is
  // actually in the registry rather than a list this page would have to grow.
  const kinds = useMemo(() => {
    const seen = new Set((templates ?? []).map((t) => t.kind));
    return [...seen].sort().map((k) => ({ value: k, label: k }));
  }, [templates]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (templates ?? []).filter((t) => {
      if (ownerId && t.owner_id !== ownerId) return false;
      if (kind && t.kind !== kind) return false;
      if (
        q &&
        !t.name.toLowerCase().includes(q) &&
        !t.description.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [templates, search, ownerId, kind]);

  const columns = useMemo<GridColDef<TemplateSummary>[]>(
    () => [
      { field: "name", headerName: "Name", flex: 1, minWidth: 180 },
      {
        field: "description",
        headerName: "Description",
        flex: 2,
        minWidth: 260,
      },
      {
        field: "kind",
        headerName: "Kind",
        width: 110,
        renderCell: ({ value }) => (
          <Chip size="small" variant="outlined" label={value as string} />
        ),
      },
      {
        field: "owner_name",
        headerName: "Owner",
        width: 150,
        renderCell: ({ value, row }) => value ?? row.owner_id,
      },
      { field: "version", headerName: "Rev", width: 70, type: "number" },
      {
        field: "size_bytes",
        headerName: "Size",
        width: 90,
        valueFormatter: (value) => formatBytes(value as number),
      },
      {
        field: "updated_at",
        headerName: "Updated",
        width: 116,
        valueFormatter: (value) => formatDate(value as string),
      },
    ],
    [],
  );

  return (
    <Box
      sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}
    >
      <ResourceFiltersBar
        search={search}
        onSearchChange={setSearch}
        ownerId={ownerId}
        onOwnerChange={setOwnerId}
        owners={owners}
        typeFilter={kind}
        onTypeChange={setKind}
        types={kinds}
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
          onRowClick={(params) => navigate(`/resources/templates/${params.id}`)}
          sx={{ "& .MuiDataGrid-row": { cursor: "pointer" } }}
        />
      )}
    </Box>
  );
}
