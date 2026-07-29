import AddCircleOutline from "@mui/icons-material/AddCircleOutline";
import ContentCopy from "@mui/icons-material/ContentCopy";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import DoneOutline from "@mui/icons-material/DoneOutline";
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid-pro";
import { useCallback, useMemo, useState } from "react";
import DataTable from "../../components/DataTable";
import { type ApiKeyDetail, deleteApiKey, revealApiKey } from "../../data/api";
import { useApiKeys } from "../../data/hooks";
import { MONO_SX, formatDate } from "../../theme/hootFormat";
import CreateKeyDialog from "./CreateKeyDialog";

export default function RegistrationKeysPage() {
  const { data: keys, loading, refetch } = useApiKeys();
  const [deleteTarget, setDeleteTarget] = useState<ApiKeyDetail | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    await deleteApiKey(deleteTarget.id);
    setDeleteTarget(null);
    setDeleting(false);
    refetch();
  }, [deleteTarget, refetch]);

  const handleCopy = useCallback(async (keyId: string) => {
    try {
      const plaintext = await revealApiKey(keyId);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(plaintext);
      } else {
        const ta = document.createElement("textarea");
        ta.value = plaintext;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopiedId(keyId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error("Failed to copy key:", err);
    }
  }, []);

  const registrationKeys = useMemo(
    () => keys?.filter((k) => k.type === "registration") ?? [],
    [keys],
  );

  const agentKeys = useMemo(
    () => keys?.filter((k) => k.type === "agent") ?? [],
    [keys],
  );

  const regColumns = useMemo<GridColDef<ApiKeyDetail>[]>(
    () => [
      { field: "label", headerName: "Label", flex: 1, minWidth: 200 },
      {
        field: "key_prefix",
        headerName: "Key Prefix",
        width: 180,
        renderCell: ({ value }) => (
          <Typography component="span" sx={MONO_SX}>
            {value}...
          </Typography>
        ),
      },
      {
        field: "created_at",
        headerName: "Created",
        flex: 1,
        minWidth: 140,
        valueFormatter: (value) => formatDate(value as string),
      },
      {
        field: "actions",
        headerName: "",
        width: 100,
        sortable: false,
        filterable: false,
        renderCell: ({ row }) => (
          <>
            <Tooltip title={copiedId === row.id ? "Copied!" : "Copy key"}>
              <IconButton size="small" onClick={() => handleCopy(row.id)}>
                {copiedId === row.id ? (
                  <DoneOutline fontSize="small" color="success" />
                ) : (
                  <ContentCopy fontSize="small" />
                )}
              </IconButton>
            </Tooltip>
            <IconButton size="small" onClick={() => setDeleteTarget(row)}>
              <DeleteOutline fontSize="small" />
            </IconButton>
          </>
        ),
      },
    ],
    [copiedId, handleCopy],
  );

  const agentColumns = useMemo<GridColDef<ApiKeyDetail>[]>(
    () => [
      { field: "label", headerName: "Agent", flex: 1, minWidth: 200 },
      {
        field: "key_prefix",
        headerName: "Key Prefix",
        width: 180,
        renderCell: ({ value }) => (
          <Typography component="span" sx={MONO_SX}>
            {value}...
          </Typography>
        ),
      },
      {
        field: "created_at",
        headerName: "Created",
        flex: 1,
        minWidth: 140,
        valueFormatter: (value) => formatDate(value as string),
      },
      {
        field: "actions",
        headerName: "",
        width: 60,
        sortable: false,
        filterable: false,
        renderCell: ({ row }) => (
          <Tooltip title={copiedId === row.id ? "Copied!" : "Copy key"}>
            <IconButton size="small" onClick={() => handleCopy(row.id)}>
              {copiedId === row.id ? (
                <DoneOutline fontSize="small" color="success" />
              ) : (
                <ContentCopy fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
        ),
      },
    ],
    [copiedId, handleCopy],
  );

  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}>
        <Typography variant="h5">API Keys</Typography>
        <Button
          variant="contained"
          startIcon={<AddCircleOutline />}
          onClick={() => setCreateOpen(true)}
        >
          Create Registration Key
        </Button>
      </Stack>

      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
        Registration Keys
      </Typography>
      {loading ? (
        <CircularProgress />
      ) : (
        <DataTable
          rows={registrationKeys}
          columns={regColumns}
          height={Math.min(400, 108 + registrationKeys.length * 52)}
          pageSize={10}
        />
      )}

      <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
        Agent Keys
      </Typography>
      {loading ? (
        <CircularProgress />
      ) : (
        <DataTable
          rows={agentKeys}
          columns={agentColumns}
          height={Math.min(400, 108 + agentKeys.length * 52)}
          pageSize={10}
        />
      )}

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Delete API key</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete key &quot;{deleteTarget?.label}&quot;? Agents
            using this key will no longer be able to register.
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

      <CreateKeyDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={refetch}
      />
    </Box>
  );
}
