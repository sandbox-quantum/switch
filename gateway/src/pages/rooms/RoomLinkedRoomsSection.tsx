import AddIcon from "@mui/icons-material/Add";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { attachLinkedRoom, detachLinkedRoom } from "../../data/api";
import { useLinkedRooms, useRooms } from "../../data/hooks";

interface Props {
  roomId: string;
}

export default function RoomLinkedRoomsSection({ roomId }: Props) {
  const { data: linked, loading, refetch } = useLinkedRooms(roomId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const handleDetach = async (targetRoomId: string) => {
    setBusy(true);
    setError(null);
    try {
      await detachLinkedRoom(roomId, targetRoomId);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove link");
    } finally {
      setBusy(false);
    }
  };

  const existingTargetIds = useMemo(
    () => new Set((linked ?? []).map((l) => l.target_room_id)),
    [linked],
  );

  return (
    <Stack spacing={1}>
      <Typography variant="body2" sx={{ fontWeight: 500 }}>
        Linked rooms
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {loading ? (
        <CircularProgress size={20} />
      ) : (linked ?? []).length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No linked rooms.
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {(linked ?? []).map((link) => (
            <Stack
              key={link.target_room_id}
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{
                px: 1,
                py: 0.5,
                borderRadius: 1,
                cursor: "pointer",
                "&:hover": { backgroundColor: "action.hover" },
              }}
              onClick={() => navigate(`/rooms/${link.target_room_id}`)}
            >
              <Chip label={link.label} size="small" />
              <Stack sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography variant="body2" noWrap>
                  {link.target_room_name}
                </Typography>
                {link.target_room_description && (
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {link.target_room_description}
                  </Typography>
                )}
              </Stack>
              <IconButton
                size="small"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDetach(link.target_room_id);
                }}
              >
                <DeleteOutline fontSize="small" />
              </IconButton>
            </Stack>
          ))}
        </Stack>
      )}
      <Button
        size="small"
        variant="outlined"
        startIcon={<AddIcon />}
        onClick={() => setDialogOpen(true)}
        sx={{ alignSelf: "flex-start" }}
      >
        Add linked room
      </Button>
      <AddLinkedRoomDialog
        open={dialogOpen}
        sourceRoomId={roomId}
        existingTargetIds={existingTargetIds}
        onClose={() => setDialogOpen(false)}
        onCreated={() => {
          setDialogOpen(false);
          refetch();
        }}
      />
    </Stack>
  );
}

function AddLinkedRoomDialog({
  open,
  sourceRoomId,
  existingTargetIds,
  onClose,
  onCreated,
}: {
  open: boolean;
  sourceRoomId: string;
  existingTargetIds: Set<string>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { data: rooms, loading } = useRooms();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const options = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rooms ?? [])
      .filter((r) => r.id !== sourceRoomId && !existingTargetIds.has(r.id))
      .filter(
        (r) =>
          !q ||
          r.name.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q),
      );
  }, [rooms, search, sourceRoomId, existingTargetIds]);

  const handleSubmit = async () => {
    if (!selectedId || !label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await attachLinkedRoom(sourceRoomId, selectedId, label.trim());
      setSearch("");
      setSelectedId(null);
      setLabel("");
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add link");
    } finally {
      setBusy(false);
    }
  };

  const handleClose = () => {
    setSearch("");
    setSelectedId(null);
    setLabel("");
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>Add linked room</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            size="small"
            placeholder="Search rooms…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            fullWidth
            autoFocus
          />
          <Box sx={{ maxHeight: 280, overflowY: "auto", border: 1, borderColor: "divider", borderRadius: 1 }}>
            {loading ? (
              <Box sx={{ p: 2, display: "flex", justifyContent: "center" }}>
                <CircularProgress size={20} />
              </Box>
            ) : options.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                No matching rooms.
              </Typography>
            ) : (
              <List dense disablePadding>
                {options.map((r) => (
                  <ListItemButton
                    key={r.id}
                    selected={selectedId === r.id}
                    onClick={() => setSelectedId(r.id)}
                  >
                    <ListItemText
                      primary={r.name}
                      secondary={r.description}
                      primaryTypographyProps={{ noWrap: true }}
                      secondaryTypographyProps={{ noWrap: true }}
                    />
                  </ListItemButton>
                ))}
              </List>
            )}
          </Box>
          <TextField
            size="small"
            label="Label"
            placeholder="e.g. support, parent project, related"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            fullWidth
            helperText="Short free-text describing the relationship."
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={busy || !selectedId || !label.trim()}
        >
          Add
        </Button>
      </DialogActions>
    </Dialog>
  );
}
