import ArrowBack from "@mui/icons-material/ArrowBack";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { detachDocumentFromRoom } from "../../data/api";
import { useRoom, useRoomDocument } from "../../data/hooks";

export default function RoomScopedDocumentView() {
  const { roomId, documentId } = useParams<{
    roomId: string;
    documentId: string;
  }>();
  const navigate = useNavigate();
  const { data: doc, loading, error } = useRoomDocument(roomId, documentId);
  // Deleting a room document (or detaching a shared one) is a write to the
  // room, so it is offered only to those who may write to it.
  const { data: room } = useRoom(roomId);
  const canWrite = !!room && room.can_write;
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !doc || !roomId || !documentId) {
    return (
      <Box>
        <Button
          startIcon={<ArrowBack />}
          onClick={() => navigate(`/rooms/${roomId ?? ""}`)}
        >
          Back to room
        </Button>
        <Alert severity="error" sx={{ mt: 2 }}>
          {error ?? "Document not found"}
        </Alert>
      </Box>
    );
  }

  const handleDelete = async () => {
    if (
      !window.confirm(
        `Delete room document “${doc.name}”? This cannot be undone.`,
      )
    )
      return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await detachDocumentFromRoom(roomId, documentId);
      navigate(`/rooms/${roomId}`);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete");
      setDeleting(false);
    }
  };

  const isRoomScoped = doc.scope === "room";

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <IconButton onClick={() => navigate(`/rooms/${roomId}`)} size="small">
          <ArrowBack />
        </IconButton>
        <Typography variant="h5" sx={{ flexGrow: 1 }}>
          {doc.name || "Document"}
        </Typography>
        {isRoomScoped && (
          <Chip label="room-scoped" size="small" variant="outlined" />
        )}
      </Stack>

      <Paper variant="outlined" sx={{ borderRadius: 2, p: 3 }}>
        <Stack spacing={3}>
          <Stack spacing={1}>
            {doc.description && (
              <Typography variant="body2" color="text.secondary">
                {doc.description}
              </Typography>
            )}
            {doc.created_by_agent_name && (
              <Typography variant="caption" color="text.secondary">
                Created by agent {doc.created_by_agent_name}
              </Typography>
            )}
          </Stack>

          {doc.instructions && (
            <Stack spacing={1}>
              <Typography variant="subtitle2">Agent instructions</Typography>
              <Paper
                variant="outlined"
                sx={{ p: 2, backgroundColor: "background.default" }}
              >
                <Typography
                  variant="body2"
                  sx={{ whiteSpace: "pre-wrap", fontFamily: "monospace" }}
                >
                  {doc.instructions}
                </Typography>
              </Paper>
            </Stack>
          )}

          <Stack spacing={1}>
            <Typography variant="subtitle2">Content</Typography>
            <Paper
              variant="outlined"
              sx={{ p: 2, backgroundColor: "background.default" }}
            >
              <Typography
                variant="body2"
                sx={{ whiteSpace: "pre-wrap", fontFamily: "monospace" }}
              >
                {doc.content}
              </Typography>
            </Paper>
          </Stack>

          {canWrite && (
            <>
              <Divider />

              {deleteError && <Alert severity="error">{deleteError}</Alert>}
              <Stack direction="row" justifyContent="flex-end">
                <Button
                  color="error"
                  startIcon={<DeleteOutline />}
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  Delete
                </Button>
              </Stack>
            </>
          )}
        </Stack>
      </Paper>
    </Box>
  );
}
