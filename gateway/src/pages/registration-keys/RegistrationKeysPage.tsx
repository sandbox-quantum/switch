import AddCircleOutline from "@mui/icons-material/AddCircleOutline";
import ContentCopy from "@mui/icons-material/ContentCopy";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import DoneOutline from "@mui/icons-material/DoneOutline";
import SearchIcon from "@mui/icons-material/Search";
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
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useCallback, useMemo, useState } from "react";
import DataTable, { TableEmptyState } from "../../components/DataTable";
import {
  type ApiKeyDetail,
  RETIRED_KEY_TYPE,
  deleteApiKey,
  revealApiKey,
} from "../../data/api";
import { useApiKeys } from "../../data/hooks";
import { MONO_SX, formatDate } from "../../theme/format";
import CreateKeyDialog from "./CreateKeyDialog";
import { formatKeyExpiry } from "./keyExpiry";

// The columns every list of keys shows, under its own heading for the label.
function keyColumns(
  labelHeader: string,
  { withExpiry }: { withExpiry: boolean },
): GridColDef<ApiKeyDetail>[] {
  return [
    { field: "label", headerName: labelHeader, flex: 1, minWidth: 200 },
    {
      field: "key_prefix",
      headerName: "Key prefix",
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
    ...(withExpiry
      ? [
          {
            field: "expires_at",
            headerName: "Expires",
            flex: 1,
            minWidth: 140,
            valueFormatter: (value: unknown) =>
              formatKeyExpiry(value as string | null, new Date()),
          } satisfies GridColDef<ApiKeyDetail>,
        ]
      : []),
  ];
}

export default function RegistrationKeysPage() {
  const { data: keys, loading, refetch } = useApiKeys();
  const [deleteTarget, setDeleteTarget] = useState<ApiKeyDetail | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [agentSearch, setAgentSearch] = useState("");

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
    // Everything that isn't an agent's own key or a retired one is a way to
    // register more agents — a personal "registration" key or the
    // deployment-wide "bootstrap" key seeded from AGENT_REGISTRATION_TOKEN.
    () =>
      keys?.filter((k) => k.type !== "agent" && k.type !== RETIRED_KEY_TYPE) ?? [],
    [keys],
  );

  const retiredKeys = useMemo(
    // Kept for a person to see and remove rather than deleted by the server.
    // None of them authenticates any more.
    () => keys?.filter((k) => k.type === RETIRED_KEY_TYPE) ?? [],
    [keys],
  );

  const agentKeys = useMemo(() => {
    const all = keys?.filter((k) => k.type === "agent") ?? [];
    const q = agentSearch.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (k) =>
        k.label.toLowerCase().includes(q) || k.key_prefix.toLowerCase().includes(q),
    );
  }, [keys, agentSearch]);

  const regColumns = useMemo<GridColDef<ApiKeyDetail>[]>(
    () => [
      ...keyColumns("Label", { withExpiry: true }),
      {
        field: "actions",
        headerName: "",
        width: 100,
        sortable: false,
        filterable: false,
        renderCell: ({ row }) => (
          <>
            {row.can_reveal && (
              <Tooltip title={copiedId === row.id ? "Copied!" : "Copy key"}>
                <IconButton size="small" onClick={() => handleCopy(row.id)}>
                  {copiedId === row.id ? (
                    <DoneOutline fontSize="small" color="success" />
                  ) : (
                    <ContentCopy fontSize="small" />
                  )}
                </IconButton>
              </Tooltip>
            )}
            {row.can_delete && (
              <IconButton
                size="small"
                onClick={() => setDeleteTarget(row)}
                aria-label={`Delete ${row.label}`}
              >
                <DeleteOutline fontSize="small" />
              </IconButton>
            )}
          </>
        ),
      },
    ],
    [copiedId, handleCopy],
  );

  const retiredColumns = useMemo<GridColDef<ApiKeyDetail>[]>(
    () => [
      ...keyColumns("Label", { withExpiry: false }),
      {
        field: "actions",
        headerName: "",
        width: 180,
        sortable: false,
        filterable: false,
        // One an agent still holds goes once the agent is deleted.
        renderCell: ({ row }) =>
          row.can_delete ? (
            <IconButton
              size="small"
              onClick={() => setDeleteTarget(row)}
              aria-label={`Delete ${row.label}`}
            >
              <DeleteOutline fontSize="small" />
            </IconButton>
          ) : (
            <Typography variant="caption" color="text.secondary">
              Delete its agent first
            </Typography>
          ),
      },
    ],
    [],
  );

  const agentColumns = useMemo<GridColDef<ApiKeyDetail>[]>(
    () => [
      ...keyColumns("Agent", { withExpiry: true }),
      {
        field: "actions",
        headerName: "",
        width: 100,
        sortable: false,
        filterable: false,
        // An agent's key cannot be deleted while the agent signs in with it;
        // one left behind by a deleted agent can.
        renderCell: ({ row }) => (
          <>
            {row.can_reveal && (
              <Tooltip title={copiedId === row.id ? "Copied!" : "Copy key"}>
                <IconButton size="small" onClick={() => handleCopy(row.id)}>
                  {copiedId === row.id ? (
                    <DoneOutline fontSize="small" color="success" />
                  ) : (
                    <ContentCopy fontSize="small" />
                  )}
                </IconButton>
              </Tooltip>
            )}
            {row.can_delete && (
              <IconButton
                size="small"
                onClick={() => setDeleteTarget(row)}
                aria-label={`Delete ${row.label}`}
              >
                <DeleteOutline fontSize="small" />
              </IconButton>
            )}
          </>
        ),
      },
    ],
    [copiedId, handleCopy],
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}>
        <Typography variant="h5">API keys</Typography>
        <Button
          variant="contained"
          startIcon={<AddCircleOutline />}
          onClick={() => setCreateOpen(true)}
        >
          Create API key
        </Button>
      </Stack>

      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
        Keys for adding agents
      </Typography>
      {loading ? (
        <CircularProgress />
      ) : (
        <Box
          sx={{
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            height: Math.min(400, 108 + Math.max(1, registrationKeys.length) * 52),
          }}
        >
          <DataTable
            rows={registrationKeys}
            columns={regColumns}
            fillHeight
            pageSize={10}
            emptyState={
              <TableEmptyState title="No keys for adding agents yet">
                Create one to let an agent join this workspace.
              </TableEmptyState>
            }
          />
        </Box>
      )}

      {!loading && retiredKeys.length > 0 && (
        <>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 3, mb: 1 }}>
            Retired keys
          </Typography>
          <Box
            sx={{
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              height: Math.min(400, 108 + retiredKeys.length * 52),
            }}
          >
            <DataTable
              rows={retiredKeys}
              columns={retiredColumns}
              fillHeight
              pageSize={10}
            />
          </Box>
        </>
      )}

      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ mt: 3, mb: 1 }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Agent keys
        </Typography>
        <TextField
          size="small"
          placeholder="Search agents…"
          value={agentSearch}
          onChange={(e) => setAgentSearch(e.target.value)}
          sx={{ width: 280 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
      </Stack>
      {loading ? (
        <CircularProgress />
      ) : (
        <DataTable
          rows={agentKeys}
          columns={agentColumns}
          fillHeight
          pageSize={25}
          emptyState={
            agentSearch.trim() ? (
              <TableEmptyState title="No agent keys match that search" />
            ) : (
              <TableEmptyState title="No agent keys yet">An agent gets its own key when it joins.</TableEmptyState>
            )
          }
        />
      )}

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Delete API key</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete key &quot;{deleteTarget?.label}&quot;?{" "}
            {deleteTarget?.type === "agent"
              ? "Its agent has been deleted, so nothing signs in with it."
              : deleteTarget?.type === RETIRED_KEY_TYPE
                ? "It no longer authenticates, so nothing depends on it."
                : "Agents using this key will no longer be able to register."}
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
