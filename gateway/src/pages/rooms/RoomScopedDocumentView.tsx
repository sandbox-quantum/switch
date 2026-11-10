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
import ConfirmDialog from "../../components/ConfirmDialog";
import { detachDocumentFromRoom } from "../../data/api";
import { useRoomDocument } from "../../data/hooks";

export default function RoomScopedDocumentView() {
  const { roomId, documentId } = useParams<{
    roomId: string;
    documentId: string;
  }>();
  const navigate = useNavigate();
  const { data: doc, loading, error } = useRoomDocument(roomId, documentId);
  const [confirming, setConfirming] = useState(false);

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

  const isRoomScoped = doc.scope === "room";

  // A room-scoped document lives only here, so removing it deletes it. An
  // attached one is only unlinked from the room. Failing, it throws, and the
  // dialog stays open with the server's reason.
  const handleDelete = async () => {
    await detachDocumentFromRoom(roomId, documentId);
    navigate(`/rooms/${roomId}`);
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <IconButton onClick={() => navigate(`/rooms/${roomId}`)} size="small" aria-label="Back">
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

          <Divider />

          {doc.can_remove && (
            <Stack direction="row" justifyContent="flex-end">
              {isRoomScoped ? (
                <Button color="error" startIcon={<DeleteOutline />} onClick={() => setConfirming(true)}>
                  Delete
                </Button>
              ) : (
                <Button onClick={() => setConfirming(true)}>Unlink from room</Button>
              )}
            </Stack>
          )}
        </Stack>
      </Paper>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={handleDelete}
        {...(isRoomScoped
          ? {
              title: `Delete ${doc.name || doc.description || "this document"}?`,
              description: "It lives only in this room, so deleting it removes it for good. This cannot be undone.",
              confirmLabel: "Delete document",
              tone: "destructive" as const,
            }
          : {
              title: `Unlink ${doc.name || doc.description || "this document"}?`,
              description: "It's taken out of this room; the document itself is kept in the library.",
              confirmLabel: "Unlink",
              tone: "plain" as const,
            })}
      />
    </Box>
  );
}
