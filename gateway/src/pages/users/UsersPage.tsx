import AddCircleOutline from "@mui/icons-material/AddCircleOutline";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";
import DataTable, {
  type SelectFilter,
  type TableColumn,
  TableEmptyState,
} from "../../components/DataTable";
import type { ListedUser } from "../../data/api";
import { useUsers } from "../../data/hooks";
import { formatDate } from "../../theme/format";
import CreateUserDialog from "./CreateUserDialog";
import DeleteUserDialog from "./DeleteUserDialog";

const ROLE_OPTIONS = [
  { value: "admin", label: "Platform operator" },
  { value: "user", label: "User" },
];

const SELECT_FILTERS: SelectFilter[] = [{ field: "role", label: "Role", allLabel: "All roles" }];

const SEARCH = {
  label: "Search users",
  text: (user: ListedUser) => `${user.name} ${user.email}`,
};

const TABLE_CHROME = 108;
const ROW = 52;
const PAGE_SIZE = 25;

export default function UsersPage() {
  const { data: users, loading, error, refetch } = useUsers();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<ListedUser | null>(null);

  const columns = useMemo<TableColumn<ListedUser>[]>(
    () => [
      { field: "name", headerName: "Name", flex: 1, minWidth: 140 },
      { field: "email", headerName: "Email", flex: 1.5, minWidth: 200 },
      {
        field: "role",
        headerName: "Role",
        width: 160,
        filter: { value: (user) => user.role, options: ROLE_OPTIONS },
        renderCell: ({ value }) => (
          <Chip
            label={value === "admin" ? "Platform operator" : "User"}
            size="small"
            color={value === "admin" ? "primary" : "default"}
          />
        ),
      },
      {
        field: "created_at",
        headerName: "Created",
        width: 140,
        type: "date",
        valueGetter: (value) => new Date(value as string),
        valueFormatter: (value) => formatDate(value as Date),
      },
      {
        field: "actions",
        headerName: "",
        width: 60,
        sortable: false,
        // The server refuses administrator accounts and your own, and says
        // which rows it would refuse. You delete your own account from your
        // account settings.
        renderCell: ({ row }) =>
          row.can_delete ? (
            <Tooltip title="Delete account">
              <IconButton
                size="small"
                onClick={() => setDeleting(row)}
                aria-label={`Delete ${row.email}`}
              >
                <DeleteOutline fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null,
      },
    ],
    [],
  );

  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}>
        <Typography variant="h5">Users</Typography>
        <Button
          variant="contained"
          startIcon={<AddCircleOutline />}
          onClick={() => setCreateOpen(true)}
        >
          Add user
        </Button>
      </Stack>

      {error !== null && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {loading && users === null ? (
        <CircularProgress />
      ) : users === null ? null : (
        <DataTable
          rows={users}
          columns={columns}
          emptyState={<TableEmptyState title="No users yet" />}
          height={TABLE_CHROME + ROW * Math.min(users.length, PAGE_SIZE)}
          pageSize={PAGE_SIZE}
          noun={{ one: "user", other: "users" }}
          search={SEARCH}
          selectFilters={SELECT_FILTERS}
          initialSort={{ field: "name", sort: "asc" }}
        />
      )}

      <CreateUserDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={refetch}
      />
      <DeleteUserDialog
        user={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={refetch}
      />
    </Box>
  );
}
