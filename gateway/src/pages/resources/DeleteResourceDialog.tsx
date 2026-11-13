import { Alert, Chip, CircularProgress, Stack } from "@mui/material";
import { useCallback } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import {
  type ResourceRoom,
  deleteDocument,
  deletePackage,
  deleteReference,
  loadDocumentRooms,
  loadPackageRooms,
  loadReferenceRooms,
} from "../../data/api";
import { useLoad } from "../workspace/useLoad";
import { privateRoomsLabel } from "./privateRooms";

type Kind = "reference" | "document" | "package";

const LOAD_ROOMS: Record<Kind, (id: string) => Promise<ResourceRoom[]>> = {
  reference: loadReferenceRooms,
  document: loadDocumentRooms,
  package: loadPackageRooms,
};

const DELETE: Record<Kind, (id: string) => Promise<unknown>> = {
  reference: deleteReference,
  document: deleteDocument,
  package: deletePackage,
};

interface Props {
  kind: Kind;
  resourceId: string;
  resourceLabel: string;
  // Rooms it is in that the viewer may not read: unnamed, but the delete
  // still removes it from them.
  hiddenRoomsCount: number;
  // Packages it is in, which the delete takes it out of. None for a package.
  packageCount: number;
  onClose: () => void;
  onDeleted: () => void;
}

/** Asks before deleting a resource, naming what it leaves: the rooms it is
 * detached from and the packages it is taken out of. Mounted only while
 * open, so the rooms are read when the question is asked, not when the page
 * was. */
export default function DeleteResourceDialog({
  kind,
  resourceId,
  resourceLabel,
  hiddenRoomsCount,
  packageCount,
  onClose,
  onDeleted,
}: Props) {
  const load = useCallback(() => LOAD_ROOMS[kind](resourceId), [kind, resourceId]);
  const { data: rooms, error, loading } = useLoad(load);
  const roomCount = (rooms ?? []).length + hiddenRoomsCount;

  return (
    <ConfirmDialog
      open
      title={`Delete ${kind}`}
      tone="destructive"
      confirmLabel="Delete"
      // Held until the question can be answered in full: deleting while
      // the rooms are still loading would skip the warning about them.
      confirmDisabled={loading && rooms === null}
      description={
        <Stack spacing={2}>
          <span>
            Delete <b>{resourceLabel}</b>? This cannot be undone.
          </span>
          {loading && rooms === null ? (
            <CircularProgress size={20} aria-label="Loading the rooms it is in" />
          ) : rooms === null ? (
            <Alert severity="error">
              Couldn't load the rooms it is in, so they aren't listed here: {error}
            </Alert>
          ) : (
            roomCount > 0 && (
              <Alert severity="warning">
                This will detach it from {roomCount} room{roomCount === 1 ? "" : "s"}:
                <Stack direction="row" flexWrap="wrap" gap={0.5} sx={{ mt: 1 }}>
                  {rooms.map((r) => (
                    <Chip key={r.room_id} size="small" label={r.room_name} />
                  ))}
                  {hiddenRoomsCount > 0 && (
                    <Chip size="small" variant="outlined" label={privateRoomsLabel(hiddenRoomsCount)} />
                  )}
                </Stack>
              </Alert>
            )
          )}
          {packageCount > 0 && (
            <Alert severity="warning">
              It is also taken out of {packageCount} package{packageCount === 1 ? "" : "s"}.
            </Alert>
          )}
        </Stack>
      }
      onConfirm={async () => {
        await DELETE[kind](resourceId);
        onDeleted();
      }}
      onClose={onClose}
    />
  );
}
