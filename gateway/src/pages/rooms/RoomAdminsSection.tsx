import { Alert, Box, Button, MenuItem, Stack, TextField, Typography } from "@mui/material";
import { useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import { addRoomAdmin, removeRoomAdmin, type RoomDetail } from "../../data/api";

/**
 * The room's room admins: people in the room its owner, or a workspace admin,
 * lets change it as the owner does. Choosing them takes `can_manage_admins`;
 * a room admin may also step down. Who can be made one comes from the server
 * (`room_admin_candidates`), which refuses anyone else with its reason.
 */
export default function RoomAdminsSection({
  room,
  viewerId,
  onChanged,
}: {
  room: RoomDetail;
  viewerId: string | null;
  onChanged: () => void;
}) {
  const admins = room.room_admins ?? [];
  const candidates = room.room_admin_candidates ?? [];
  const canChoose = room.can_manage_admins ?? false;
  const [picked, setPicked] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steppingDown, setSteppingDown] = useState(false);

  const change = async (run: () => Promise<unknown>, failure: string) => {
    setWorking(true);
    setError(null);
    try {
      await run();
      onChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
      return false;
    } finally {
      setWorking(false);
    }
  };

  const add = async () => {
    if (await change(() => addRoomAdmin(room.id, picked), "Failed to add the room admin")) {
      setPicked("");
    }
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Room admins
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Room admins change this room as its owner does, except deleting it,
        changing who can see it, transferring it and choosing room admins.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <Stack spacing={0.5}>
        {admins.map((admin) => {
          const isViewer = admin.user_id === viewerId;
          const label = admin.name ?? admin.user_id;
          return (
            <Stack key={admin.user_id} direction="row" alignItems="center" spacing={1}>
              <Typography variant="body2" sx={{ flexGrow: 1 }}>
                {label}
                {isViewer && (
                  <Box component="span" sx={{ color: "text.secondary" }}>
                    {" "}
                    (you)
                  </Box>
                )}
              </Typography>
              {canChoose ? (
                <Button
                  size="small"
                  disabled={working}
                  onClick={() =>
                    change(
                      () => removeRoomAdmin(room.id, admin.user_id),
                      "Failed to remove the room admin",
                    )
                  }
                  aria-label={`Remove ${label} as room admin`}
                >
                  Remove
                </Button>
              ) : (
                isViewer && (
                  <Button size="small" disabled={working} onClick={() => setSteppingDown(true)}>
                    Step down
                  </Button>
                )
              )}
            </Stack>
          );
        })}
        {admins.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No room admins.
          </Typography>
        )}
      </Stack>
      {canChoose &&
        (candidates.length > 0 ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField
              select
              size="small"
              label="Person in the room"
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              disabled={working}
              sx={{ width: 280 }}
            >
              {candidates.map((person) => (
                <MenuItem key={person.user_id} value={person.user_id}>
                  {person.name}
                </MenuItem>
              ))}
            </TextField>
            <Button variant="outlined" size="small" disabled={!picked || working} onClick={add}>
              Make room admin
            </Button>
          </Stack>
        ) : (
          <Typography variant="caption" color="text.secondary">
            No one else here can be made a room admin. Only people in the room
            with a Switch account can be.
          </Typography>
        ))}
      <ConfirmDialog
        open={steppingDown}
        title="Step down as room admin?"
        description="You will no longer be able to change this room. Its owner or a workspace admin can make you a room admin again."
        confirmLabel="Step down"
        tone="destructive"
        onConfirm={async () => {
          await removeRoomAdmin(room.id, viewerId ?? "");
          onChanged();
        }}
        onClose={() => setSteppingDown(false)}
      />
    </Stack>
  );
}
