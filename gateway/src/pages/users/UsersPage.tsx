import AddCircleOutline from "@mui/icons-material/AddCircleOutline";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useMemo, useState } from "react";
import DataTable, { TableEmptyState } from "../../components/DataTable";
import type { ListedUser } from "../../data/api";
import { useUsers } from "../../data/hooks";
import { formatDate } from "../../theme/format";
import CreateUserDialog from "./CreateUserDialog";
import DeleteUserDialog from "./DeleteUserDialog";

export default function UsersPage() {
  const { data: users, loading, refetch } = useUsers();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<ListedUser | null>(null);

  const columns = useMemo<GridColDef<ListedUser>[]>(
    () => [
      { field: "name", headerName: "Name", flex: 1, minWidth: 140 },
      { field: "email", headerName: "Email", flex: 1.5, minWidth: 200 },
      {
        field: "role",
        headerName: "Role",
        width: 160,
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
        valueFormatter: (value) => formatDate(value as string),
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

      {loading ? (
        <CircularProgress />
      ) : (
        <DataTable
          rows={users ?? []}
          columns={columns}
          emptyState={<TableEmptyState title="No users yet" />}
          height={Math.min(600, 108 + (users?.length ?? 0) * 52)}
          pageSize={25}
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
