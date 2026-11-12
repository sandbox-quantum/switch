import AddCircleOutline from "@mui/icons-material/AddCircleOutline";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import LogoutOutlined from "@mui/icons-material/LogoutOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Snackbar,
  Stack,
  Typography,
} from "@mui/material";
import { useCallback, useMemo, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import DataTable, {
  type SelectFilter,
  type TableColumn,
  TableEmptyState,
} from "../../components/DataTable";
import RowActionsMenu, { type RowAction } from "../../components/RowActionsMenu";
import { type ListedUser, endUserSessions } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
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
const PINNED = ["actions"];

export default function UsersPage() {
  const { data: users, loading, error, refetch } = useUsers();
  const { user: me } = useAuth();
  const selfId = me?.id ?? null;
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<ListedUser | null>(null);
  // Kept after the dialog closes, so its text does not empty as it fades.
  const [signingOut, setSigningOut] = useState<ListedUser | null>(null);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Your own sessions end from the account menu, which signs you out here
  // too. The server refuses deleting administrator accounts and your own,
  // and says which rows it would refuse; you delete your own account from
  // your account settings.
  const actionsFor = useCallback(
    (row: ListedUser): RowAction[] => [
      ...(row.id === selfId
        ? []
        : [
            {
              label: "Sign out of all devices",
              icon: <LogoutOutlined fontSize="small" />,
              destructive: true,
              onClick: () => {
                setSigningOut(row);
                setSignOutOpen(true);
              },
            },
          ]),
      ...(row.can_delete
        ? [
            {
              label: "Delete account",
              icon: <DeleteOutline fontSize="small" />,
              destructive: true,
              onClick: () => setDeleting(row),
            },
          ]
        : []),
    ],
    [selfId],
  );

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
        width: 56,
        sortable: false,
        disableColumnMenu: true,
        renderCell: ({ row, tabIndex }) => (
          <RowActionsMenu
            label={`Actions for ${row.email}`}
            actions={actionsFor(row)}
            tabIndex={tabIndex}
          />
        ),
      },
    ],
    [actionsFor],
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
          pinnedRight={PINNED}
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
      <ConfirmDialog
        open={signOutOpen}
        title={`Sign ${signingOut?.name ?? ""} out of all devices?`}
        description={
          signingOut && (
            <>
              Every session {signingOut.name} ({signingOut.email}) has ends now, Switch Console's
              included, and they have to sign in again. Their password stays as it is: if the
              account looks taken over, ask them to change it too.
            </>
          )
        }
        confirmLabel="Sign out"
        tone="destructive"
        onConfirm={async () => {
          if (signingOut === null) return;
          await endUserSessions(signingOut.id);
          setNotice(`Signed ${signingOut.name} out of all devices.`);
        }}
        onClose={() => setSignOutOpen(false)}
      />
      <Snackbar
        open={notice !== null}
        autoHideDuration={4000}
        onClose={() => setNotice(null)}
        message={notice}
      />
    </Box>
  );
}
