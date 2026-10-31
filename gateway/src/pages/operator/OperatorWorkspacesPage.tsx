import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useCallback, useMemo, useState } from "react";
import DataTable from "../../components/DataTable";
import { useAuth } from "../../data/AuthContext";
import { type OperatorWorkspace, fetchOperatorWorkspaces } from "../../data/api";
import { useLoad } from "../workspace/useLoad";

/** Every workspace on the server, for the platform operator. Listing records
 * nothing; entering one you hold no role in is recorded in its audit log, as
 * is every change you make there. */
export default function OperatorWorkspacesPage() {
  const load = useCallback(() => fetchOperatorWorkspaces(), []);
  const { data: workspaces, error, loading } = useLoad(load);
  const { session, switchTo } = useAuth();
  const [switchError, setSwitchError] = useState<string | null>(null);
  const currentId = session?.tenant?.id;

  const columns = useMemo<GridColDef<OperatorWorkspace>[]>(
    () => [
      {
        field: "name",
        headerName: "Workspace",
        flex: 1,
        minWidth: 160,
        renderCell: ({ row }) => (row.id === currentId ? `${row.name} (current)` : row.name),
      },
      { field: "slug", headerName: "Slug", flex: 1, minWidth: 140 },
      {
        field: "organization_name",
        headerName: "Organization",
        flex: 1,
        minWidth: 160,
        valueGetter: (value, row) => value ?? row.organization_id ?? "None",
      },
      {
        field: "actions",
        headerName: "",
        width: 110,
        sortable: false,
        renderCell: ({ row }) =>
          row.id === currentId ? null : (
            <Button
              size="small"
              onClick={() =>
                switchTo(row.id).catch((err: unknown) =>
                  setSwitchError(err instanceof Error ? err.message : "Could not enter"),
                )
              }
            >
              Enter
            </Button>
          ),
      },
    ],
    [currentId, switchTo],
  );

  return (
    <Box>
      <Stack spacing={0.5} mb={2}>
        <Typography variant="h5">All workspaces</Typography>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          Entering a workspace you hold no role in is recorded in its audit log, and so is every
          change you make there.
        </Typography>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      {switchError && (
        <Alert severity="error" onClose={() => setSwitchError(null)}>
          {switchError}
        </Alert>
      )}
      {loading ? (
        <CircularProgress />
      ) : (
        <DataTable
          rows={workspaces ?? []}
          columns={columns}
          height={Math.min(600, 108 + (workspaces?.length ?? 0) * 52)}
          pageSize={25}
        />
      )}
    </Box>
  );
}
