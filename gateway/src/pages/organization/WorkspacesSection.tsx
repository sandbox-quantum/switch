import AddCircleOutline from "@mui/icons-material/AddCircleOutline";
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useCallback, useMemo, useState } from "react";
import DataTable from "../../components/DataTable";
import { useAuth } from "../../data/AuthContext";
import {
  type TenantMembership,
  createOrganizationWorkspace,
  fetchOrganizationWorkspaces,
} from "../../data/api";
import { titleCase } from "../../theme/hootFormat";
import { useLoad } from "../workspace/useLoad";

interface Props {
  currentId: string;
  canAdd: boolean;
}

/** The organization's workspaces the person may enter: every one for an
 * organization admin, their own for a member. Adding one keeps the session
 * where it is; switching into it is a separate step. */
export default function WorkspacesSection({ currentId, canAdd }: Props) {
  const load = useCallback(() => fetchOrganizationWorkspaces(), []);
  const { data: workspaces, error, loading, refetch } = useLoad(load);
  const { switchTo } = useAuth();
  const [actionError, setActionError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const columns = useMemo<GridColDef<TenantMembership>[]>(
    () => [
      {
        field: "name",
        headerName: "Workspace",
        flex: 1,
        minWidth: 160,
        renderCell: ({ row }) => (row.id === currentId ? `${row.name} (current)` : row.name),
      },
      {
        field: "role",
        headerName: "Your role",
        width: 140,
        valueFormatter: (value) => titleCase(String(value)),
      },
      {
        field: "actions",
        headerName: "",
        width: 120,
        sortable: false,
        renderCell: ({ row }) =>
          row.id === currentId ? null : (
            <Button
              size="small"
              onClick={() =>
                switchTo(row.id).catch((err: unknown) =>
                  setActionError(err instanceof Error ? err.message : "Could not switch"),
                )
              }
            >
              Switch
            </Button>
          ),
      },
    ],
    [currentId, switchTo],
  );

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="h6">Workspaces</Typography>
        {canAdd && (
          <Button startIcon={<AddCircleOutline />} onClick={() => setAddOpen(true)}>
            Add workspace
          </Button>
        )}
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      {actionError && (
        <Alert severity="error" onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      {loading ? (
        <CircularProgress />
      ) : (
        <DataTable
          rows={workspaces ?? []}
          columns={columns}
          height={Math.min(420, 108 + (workspaces?.length ?? 0) * 52)}
          pageSize={25}
        />
      )}
      <AddWorkspaceDialog open={addOpen} onClose={() => setAddOpen(false)} onAdded={refetch} />
    </Stack>
  );
}

function AddWorkspaceDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const close = () => {
    setName("");
    setError(null);
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createOrganizationWorkspace(name.trim());
      await onAdded();
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the workspace");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
      <form onSubmit={submit}>
        <DialogTitle>Add a workspace</DialogTitle>
        <DialogContent sx={{ pt: "8px !important" }}>
          <Stack spacing={2}>
            {error && <Alert severity="error">{error}</Alert>}
            <TextField
              label="Workspace name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              helperText="You become its owner. Every organization admin administers it."
              required
              autoFocus
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={submitting || name.trim() === ""}>
            Add workspace
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
