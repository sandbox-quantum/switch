import AddIcon from "@mui/icons-material/Add";
import {
  Alert,
  Button,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";
import SearchablePickerDialog, {
  type PickerOption,
} from "../../components/SearchablePickerDialog";
import {
  attachDocumentToRoom,
  attachPackageToRoom,
  attachReferenceToRoom,
  detachDocumentFromRoom,
  detachPackageFromRoom,
  detachReferenceFromRoom,
} from "../../data/api";
import {
  useDocumentRooms,
  usePackageRooms,
  useReferenceRooms,
  useRooms,
} from "../../data/hooks";
import { privateRoomsLabel } from "./privateRooms";

interface Props {
  kind: "reference" | "document" | "package";
  resourceId: string;
  // Rooms it is in that the viewer may not read, which are never named.
  hiddenRoomsCount: number;
}

export default function ResourceAttachmentsSection({
  kind,
  resourceId,
  hiddenRoomsCount,
}: Props) {
  const refRooms = useReferenceRooms(kind === "reference" ? resourceId : undefined);
  const docRooms = useDocumentRooms(kind === "document" ? resourceId : undefined);
  const pkgRooms = usePackageRooms(kind === "package" ? resourceId : undefined);
  const { data: attached, loading, error, refetch } =
    kind === "reference" ? refRooms : kind === "document" ? docRooms : pkgRooms;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error_, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attachedIds = useMemo(
    () => new Set((attached ?? []).map((r) => r.room_id)),
    [attached],
  );

  const handleAttach = async (roomIds: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await Promise.all(
        roomIds.map((roomId) => {
          if (kind === "reference") return attachReferenceToRoom(roomId, resourceId);
          if (kind === "document") return attachDocumentToRoom(roomId, resourceId);
          return attachPackageToRoom(roomId, resourceId);
        }),
      );
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to attach");
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const handleDetach = async (roomId: string) => {
    setBusy(true);
    setError(null);
    try {
      if (kind === "reference") {
        await detachReferenceFromRoom(roomId, resourceId);
      } else if (kind === "document") {
        await detachDocumentFromRoom(roomId, resourceId);
      } else {
        await detachPackageFromRoom(roomId, resourceId);
      }
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to detach");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Attached to
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {error_ && <Alert severity="error">{error_}</Alert>}
      {loading ? (
        <CircularProgress size={20} />
      ) : (attached ?? []).length === 0 && hiddenRoomsCount === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Not attached to any rooms yet.
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {(attached ?? []).map((r) => (
            <Stack
              key={r.room_id}
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{
                px: 1,
                py: 0.5,
                borderRadius: 1,
                "&:hover": { backgroundColor: "action.hover" },
              }}
            >
              <Typography variant="body2" sx={{ flexGrow: 1 }}>
                {r.room_name}
              </Typography>
              {r.can_unlink && (
                <Button
                  size="small"
                  onClick={() => handleDetach(r.room_id)}
                  disabled={busy}
                  aria-label={`Detach from ${r.room_name}`}
                >
                  Detach
                </Button>
              )}
            </Stack>
          ))}
          {hiddenRoomsCount > 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 0.5 }}>
              {(attached ?? []).length > 0 ? "Also in" : "In"}{" "}
              {privateRoomsLabel(hiddenRoomsCount)}.
            </Typography>
          )}
        </Stack>
      )}
      <Button
        size="small"
        variant="outlined"
        startIcon={<AddIcon />}
        onClick={() => setPickerOpen(true)}
        sx={{ alignSelf: "flex-start" }}
      >
        Attach to room
      </Button>
      {pickerOpen && (
        <RoomPicker
          attachedIds={attachedIds}
          onClose={() => setPickerOpen(false)}
          onSubmit={handleAttach}
        />
      )}
    </Stack>
  );
}

// Mounted only while open, so the room list loads only when someone attaches.
// It offers the rooms the viewer may write to: attaching needs that.
function RoomPicker({
  attachedIds,
  onClose,
  onSubmit,
}: {
  attachedIds: Set<string>;
  onClose: () => void;
  onSubmit: (roomIds: string[]) => Promise<void>;
}) {
  const { data: rooms, loading } = useRooms();
  const options = useMemo<PickerOption[]>(
    () =>
      (rooms ?? [])
        .filter((r) => r.can_write && !attachedIds.has(r.id))
        .map((r) => ({
          id: r.id,
          primary: r.name,
          secondary: r.description || undefined,
          search: `${r.name} ${r.description ?? ""}`.toLowerCase(),
        })),
    [rooms, attachedIds],
  );
  return (
    <SearchablePickerDialog
      open
      title="Attach to rooms"
      searchPlaceholder="Search rooms…"
      submitLabel="Attach"
      options={options}
      loading={loading}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}
