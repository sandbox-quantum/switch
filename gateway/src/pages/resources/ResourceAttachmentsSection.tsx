import AddIcon from "@mui/icons-material/Add";
import {
  Alert,
  Button,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { useCallback, useMemo, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import SearchablePickerDialog, {
  type PickerOption,
} from "../../components/SearchablePickerDialog";
import {
  type ResourceRoom,
  attachDocumentToRoom,
  attachPackageToRoom,
  attachReferenceToRoom,
  detachDocumentFromRoom,
  detachPackageFromRoom,
  detachReferenceFromRoom,
  loadDocumentRooms,
  loadPackageRooms,
  loadReferenceRooms,
} from "../../data/api";
import { useRooms } from "../../data/hooks";
import { useLoad } from "../workspace/useLoad";
import { privateRoomsLabel } from "./privateRooms";

type Kind = "reference" | "document" | "package";

const LOAD_ROOMS: Record<Kind, (id: string) => Promise<ResourceRoom[]>> = {
  reference: loadReferenceRooms,
  document: loadDocumentRooms,
  package: loadPackageRooms,
};

const ATTACH: Record<Kind, (roomId: string, id: string) => Promise<unknown>> = {
  reference: attachReferenceToRoom,
  document: attachDocumentToRoom,
  package: attachPackageToRoom,
};

const DETACH: Record<Kind, (roomId: string, id: string) => Promise<void>> = {
  reference: detachReferenceFromRoom,
  document: detachDocumentFromRoom,
  package: detachPackageFromRoom,
};

interface Props {
  kind: Kind;
  resourceId: string;
  resourceLabel: string;
  // Rooms it is in that the viewer may not read, which are never named.
  hiddenRoomsCount: number;
  // False for a document that belongs to one room, which joins no other.
  canAttach: boolean;
}

export default function ResourceAttachmentsSection({
  kind,
  resourceId,
  resourceLabel,
  hiddenRoomsCount,
  canAttach,
}: Props) {
  const load = useCallback(() => LOAD_ROOMS[kind](resourceId), [kind, resourceId]);
  const { data: attached, loading, error, refetch } = useLoad(load);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [unlinking, setUnlinking] = useState<ResourceRoom | null>(null);

  const attachedIds = useMemo(
    () => new Set((attached ?? []).map((r) => r.room_id)),
    [attached],
  );

  // Each room is attached on its own, so some may go in while others are
  // refused. The list shows what went in either way; the picker stays open
  // with the reasons for the rest.
  const handleAttach = async (roomIds: string[]) => {
    const results = await Promise.allSettled(roomIds.map((roomId) => ATTACH[kind](roomId, resourceId)));
    // Awaited, so the picker no longer offers what went in by the time it
    // shows the reasons for the rest.
    await refetch();
    const refused = results.flatMap((result) =>
      result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : [],
    );
    if (refused.length === 0) return;
    const reasons = [...new Set(refused)].join(" ");
    throw new Error(
      refused.length === roomIds.length
        ? reasons
        : `Attached to ${roomIds.length - refused.length} of ${roomIds.length} rooms. ${reasons}`,
    );
  };

  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Attached to
      </Typography>
      {loading && attached === null ? (
        <CircularProgress size={20} />
      ) : attached === null ? (
        <Alert severity="error">Couldn't load the rooms it is in: {error}</Alert>
      ) : attached.length === 0 && hiddenRoomsCount === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Not attached to any rooms yet.
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {error && <Alert severity="warning">Couldn't refresh the rooms it is in: {error}</Alert>}
          {attached.map((r) => (
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
                  onClick={() => setUnlinking(r)}
                  aria-label={`Unlink from ${r.room_name}`}
                >
                  Unlink
                </Button>
              )}
            </Stack>
          ))}
          {hiddenRoomsCount > 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 0.5 }}>
              {attached.length > 0 ? "Also in" : "In"}{" "}
              {privateRoomsLabel(hiddenRoomsCount)}.
            </Typography>
          )}
        </Stack>
      )}
      {canAttach && (
        <Button
          size="small"
          variant="outlined"
          startIcon={<AddIcon />}
          onClick={() => setPickerOpen(true)}
          sx={{ alignSelf: "flex-start" }}
        >
          Attach to room
        </Button>
      )}
      {pickerOpen && (
        <RoomPicker
          attachedIds={attachedIds}
          onClose={() => setPickerOpen(false)}
          onSubmit={handleAttach}
        />
      )}
      <ConfirmDialog
        open={unlinking !== null}
        title={`Unlink from ${unlinking?.room_name ?? "the room"}`}
        tone="destructive"
        confirmLabel="Unlink"
        description={
          <>
            Agents in {unlinking?.room_name} stop getting <b>{resourceLabel}</b>. The {kind} itself is
            kept, and can be attached again.
          </>
        }
        onConfirm={async () => {
          if (!unlinking) return;
          await DETACH[kind](unlinking.room_id, resourceId);
          void refetch();
        }}
        onClose={() => setUnlinking(null)}
      />
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
