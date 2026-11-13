import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { useCallback, useMemo, useState } from "react";
import DataTable, {
  type SelectFilter,
  type TableColumn,
  TableEmptyState,
} from "../../components/DataTable";
import { useAuth } from "../../data/AuthContext";
import { type OperatorWorkspace, fetchOperatorWorkspaces } from "../../data/api";
import { useLoad } from "../workspace/useLoad";

/** What the Organization column reads for a workspace in none. */
const NO_ORGANIZATION = "None";

function organizationOf(workspace: OperatorWorkspace): string {
  return workspace.organization_name ?? workspace.organization_id ?? NO_ORGANIZATION;
}

const SELECT_FILTERS: SelectFilter[] = [
  { field: "organization_name", label: "Organization", allLabel: "All organizations" },
];

const SEARCH = {
  label: "Search workspaces",
  text: (workspace: OperatorWorkspace) =>
    `${workspace.name} ${workspace.slug} ${organizationOf(workspace)}`,
};

const TABLE_CHROME = 108;
const ROW = 52;
const PAGE_SIZE = 25;

/** Every workspace on the server, for the platform operator. Listing records
 * nothing; entering one you hold no role in is recorded in its audit log, as
 * is every change you make there. */
export default function OperatorWorkspacesPage() {
  const load = useCallback(() => fetchOperatorWorkspaces(), []);
  const { data: workspaces, error, loading } = useLoad(load);
  const { session, switchTo } = useAuth();
  const [switchError, setSwitchError] = useState<string | null>(null);
  const currentId = session?.tenant?.id;

  const columns = useMemo<TableColumn<OperatorWorkspace>[]>(
    () => [
      {
        field: "name",
        headerName: "Workspace",
        flex: 1,
        minWidth: 160,
        renderCell: ({ row }) =>
          [row.name, row.id === currentId && "(current)", row.archived_at !== null && "(archived)"]
            .filter(Boolean)
            .join(" "),
      },
      { field: "slug", headerName: "Slug", flex: 1, minWidth: 140 },
      {
        field: "organization_name",
        headerName: "Organization",
        flex: 1,
        minWidth: 160,
        valueGetter: (_value, row) => organizationOf(row),
        filter: { value: organizationOf },
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
      ) : workspaces === null ? null : (
        <DataTable
          rows={workspaces}
          columns={columns}
          emptyState={<TableEmptyState title="No workspaces yet" />}
          height={TABLE_CHROME + ROW * Math.min(workspaces.length, PAGE_SIZE)}
          pageSize={PAGE_SIZE}
          noun={{ one: "workspace", other: "workspaces" }}
          search={SEARCH}
          selectFilters={SELECT_FILTERS}
          initialSort={{ field: "name", sort: "asc" }}
        />
      )}
    </Box>
  );
}
