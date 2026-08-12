import AddLinkOutlined from "@mui/icons-material/AddLinkOutlined";
import AddOutlined from "@mui/icons-material/AddOutlined";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import OpenInNewOutlined from "@mui/icons-material/OpenInNewOutlined";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useCallback, useMemo, useState } from "react";
import DataTable from "../../components/DataTable";
import { type BridgeDetail, deleteBridge, updateBridge } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { useBridges } from "../../data/hooks";
import { formatDate, titleCase } from "../../theme/hootFormat";
import RegisterMessagingAppDialog from "./RegisterMessagingAppDialog";

type BridgeRow = BridgeDetail & { id: string };

const STATUS_COLOR: Record<string, "success" | "error" | "default"> = {
  active: "success",
  error: "error",
  inactive: "default",
};

export default function CollaborationsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data: bridges, loading, refetch } = useBridges();
  const [deleteTarget, setDeleteTarget] = useState<BridgeDetail | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [installTarget, setInstallTarget] = useState<BridgeDetail | null>(null);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    await deleteBridge(deleteTarget.bridge_id);
    setDeleteTarget(null);
    setDeleting(false);
    refetch();
  }, [deleteTarget, refetch]);

  const handleToggleGreetings = useCallback(
    async (bridgeId: string, enabled: boolean) => {
      setSavingId(bridgeId);
      await updateBridge(bridgeId, { agent_greetings_enabled: enabled });
      setSavingId(null);
      refetch();
    },
    [refetch],
  );

  const columns = useMemo<GridColDef<BridgeRow>[]>(
    () => [
      {
        field: "display_name",
        headerName: "Name",
        flex: 1,
        minWidth: 160,
      },
      {
        field: "bridge_type",
        headerName: "Type",
        width: 130,
        renderCell: ({ value }) => (
          <Chip label={titleCase(String(value))} size="small" />
        ),
      },
      {
        field: "status",
        headerName: "Status",
        width: 130,
        renderCell: ({ value }) => (
          <Chip
            label={titleCase(String(value))}
            size="small"
            color={STATUS_COLOR[value as string] ?? "default"}
          />
        ),
      },
      { field: "room_count", headerName: "Rooms", width: 90, type: "number" },
      {
        field: "agent_greetings_enabled",
        headerName: "Agent greetings",
        width: 150,
        sortable: false,
        renderCell: ({ row }: { row: BridgeRow }) => (
          <Switch
            size="small"
            checked={row.agent_greetings_enabled}
            disabled={!isAdmin || savingId === row.bridge_id}
            onChange={(e) =>
              handleToggleGreetings(row.bridge_id, e.target.checked)
            }
          />
        ),
      },
      {
        field: "created_at",
        headerName: "Created",
        width: 140,
        valueFormatter: (value) => formatDate(value as string),
      },
      ...(isAdmin
        ? [
            {
              field: "actions" as const,
              headerName: "",
              width: 110,
              sortable: false,
              filterable: false,
              renderCell: ({ row }: { row: BridgeRow }) => (
                <Stack direction="row" spacing={0.5}>
                  {(row.install_links ?? []).length > 0 && (
                    <Tooltip title="Add this app to a chat">
                      <IconButton
                        size="small"
                        onClick={() => setInstallTarget(row)}
                      >
                        <AddLinkOutlined fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                  <IconButton size="small" onClick={() => setDeleteTarget(row)}>
                    <DeleteOutline fontSize="small" />
                  </IconButton>
                </Stack>
              ),
            },
          ]
        : []),
    ],
    [isAdmin, savingId, handleToggleGreetings],
  );

  const rows = useMemo<BridgeRow[]>(
    () => (bridges ?? []).map((b) => ({ ...b, id: b.bridge_id })),
    [bridges],
  );

  return (
    <Box>
      <Stack direction="row" alignItems="center" mb={2}>
        <Typography variant="h5">Messaging Apps</Typography>
        {isAdmin && (
          <Button
            variant="contained"
            startIcon={<AddOutlined />}
            sx={{ ml: "auto" }}
            onClick={() => setRegisterOpen(true)}
          >
            Register messaging app
          </Button>
        )}
      </Stack>

      {loading ? (
        <CircularProgress />
      ) : (
        <DataTable rows={rows} columns={columns} />
      )}

      <RegisterMessagingAppDialog
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onSuccess={() => refetch()}
      />

      <Dialog
        open={!!installTarget}
        onClose={() => setInstallTarget(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Add {installTarget?.display_name} to a chat</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Each link opens {titleCase(installTarget?.bridge_type ?? "")}, asks
            which chat to join, and grants the permissions the bridge needs in
            the same confirmation. Switch creates the room as soon as the bot
            lands in the chat.
          </DialogContentText>
          <Stack spacing={2}>
            {(installTarget?.install_links ?? []).map((link) => (
              <Box key={link.key}>
                <Button
                  variant="outlined"
                  startIcon={<OpenInNewOutlined />}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {link.label}
                </Button>
                <Typography variant="body2" color="text.secondary" mt={0.5}>
                  {link.description}
                </Typography>
              </Box>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setInstallTarget(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Delete collaboration bridge</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete &quot;{deleteTarget?.display_name}&quot; (
            {deleteTarget?.bridge_type})? This will also delete all{" "}
            {deleteTarget?.room_count ?? 0} associated room
            {deleteTarget?.room_count === 1 ? "" : "s"} and external users.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={handleDelete}
            disabled={deleting}
            startIcon={deleting ? <CircularProgress size={16} /> : undefined}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
