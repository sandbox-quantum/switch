import {
  Alert,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
} from "@mui/material";
import { useState } from "react";
import {
  deleteDocument,
  deletePackage,
  deleteReference,
  type ResourceDeleteResult,
} from "../../data/api";
import {
  useDocumentRooms,
  usePackageRooms,
  useReferenceRooms,
} from "../../data/hooks";
import { privateRoomsLabel } from "./privateRooms";

interface Props {
  open: boolean;
  kind: "reference" | "document" | "package";
  resourceId: string;
  resourceLabel: string;
  // Rooms it is in that the viewer may not read: unnamed, but the delete
  // still removes it from them.
  hiddenRoomsCount: number;
  onClose: () => void;
  onDeleted: () => void;
}

export default function DeleteResourceDialog({
  open,
  kind,
  resourceId,
  resourceLabel,
  hiddenRoomsCount,
  onClose,
  onDeleted,
}: Props) {
  const refRooms = useReferenceRooms(kind === "reference" ? resourceId : undefined);
  const docRooms = useDocumentRooms(kind === "document" ? resourceId : undefined);
  const pkgRooms = usePackageRooms(kind === "package" ? resourceId : undefined);
  const { data: rooms, loading } =
    kind === "reference" ? refRooms : kind === "document" ? docRooms : pkgRooms;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [affectedPackages, setAffectedPackages] = useState<string[] | null>(null);

  const handleClose = () => {
    if (submitting) return;
    setError(null);
    setAffectedPackages(null);
    onClose();
  };

  const handleDelete = async () => {
    setSubmitting(true);
    setError(null);
    try {
      let result: ResourceDeleteResult;
      if (kind === "reference") result = await deleteReference(resourceId);
      else if (kind === "document") result = await deleteDocument(resourceId);
      else result = await deletePackage(resourceId);
      setAffectedPackages(result.affected_package_ids ?? null);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="xs">
      <DialogTitle>Delete {kind}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          Delete <b>{resourceLabel}</b>? This cannot be undone.
        </DialogContentText>
        {loading ? (
          <CircularProgress size={20} />
        ) : (rooms ?? []).length + hiddenRoomsCount > 0 ? (
          <Alert severity="warning">
            This will detach from {(rooms ?? []).length + hiddenRoomsCount} room
            {(rooms ?? []).length + hiddenRoomsCount === 1 ? "" : "s"}:
            <Stack direction="row" flexWrap="wrap" gap={0.5} sx={{ mt: 1 }}>
              {(rooms ?? []).map((r) => (
                <Chip key={r.room_id} size="small" label={r.room_name} />
              ))}
              {hiddenRoomsCount > 0 && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={privateRoomsLabel(hiddenRoomsCount)}
                />
              )}
            </Stack>
          </Alert>
        ) : null}
        {affectedPackages && affectedPackages.length > 0 && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            Also removed from {affectedPackages.length} package
            {affectedPackages.length === 1 ? "" : "s"}.
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          color="error"
          variant="contained"
          onClick={handleDelete}
          disabled={submitting}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
        >
          Delete
        </Button>
      </DialogActions>
    </Dialog>
  );
}
