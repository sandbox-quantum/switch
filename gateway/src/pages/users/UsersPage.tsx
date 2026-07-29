import AddCircleOutline from "@mui/icons-material/AddCircleOutline";
import { Box, Button, Chip, CircularProgress, Stack, Typography } from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useMemo, useState } from "react";
import DataTable from "../../components/DataTable";
import type { UserInfo } from "../../data/api";
import { useUsers } from "../../data/hooks";
import { formatDate, titleCase } from "../../theme/hootFormat";
import CreateUserDialog from "./CreateUserDialog";

export default function UsersPage() {
  const { data: users, loading, refetch } = useUsers();
  const [createOpen, setCreateOpen] = useState(false);

  const columns = useMemo<GridColDef<UserInfo>[]>(
    () => [
      { field: "name", headerName: "Name", flex: 1, minWidth: 140 },
      { field: "email", headerName: "Email", flex: 1.5, minWidth: 200 },
      {
        field: "role",
        headerName: "Role",
        width: 120,
        renderCell: ({ value }) => (
          <Chip
            label={titleCase(String(value))}
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
          Add User
        </Button>
      </Stack>

      {loading ? (
        <CircularProgress />
      ) : (
        <DataTable
          rows={users ?? []}
          columns={columns}
          height={Math.min(600, 108 + (users?.length ?? 0) * 52)}
          pageSize={25}
        />
      )}

      <CreateUserDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={refetch}
      />
    </Box>
  );
}
