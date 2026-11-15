import { Alert, Box, Button, MenuItem, Stack, TextField, Typography } from "@mui/material";
import { useCallback, useMemo, useState } from "react";
import { type RoomDetail, setRoomGroup } from "../../data/api";
import { useRoomGroups } from "../../data/hooks";
import { buildGroupIndex, effectiveColor, flattenTree } from "./groupTree";

/** The room's group. A workspace admin puts the room in any group; anyone
 * else who can write to the room sees its group and may take it out. */
export default function RoomGroupSection({
  room,
  canWrite,
  canFile,
  onChanged,
}: {
  room: RoomDetail;
  canWrite: boolean;
  /** May put the room in a group: a workspace admin. Anyone who can write may take it out. */
  canFile: boolean;
  onChanged: () => void;
}) {
  const { data: groups, refetch: refetchGroups } = useRoomGroups();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groupList = useMemo(() => groups ?? [], [groups]);
  const byId = useMemo(() => buildGroupIndex(groupList), [groupList]);
  const choices = useMemo(() => flattenTree(groupList), [groupList]);
  const currentName = room.group_id
    ? (byId.get(room.group_id)?.name ?? room.group_name ?? "A group not in your list")
    : "Standalone (no group)";

  const handleChange = useCallback(
    async (value: string) => {
      setSaving(true);
      setError(null);
      try {
        await setRoomGroup(room.id, value || null);
        refetchGroups();
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update group");
      } finally {
        setSaving(false);
      }
    },
    [room.id, onChanged, refetchGroups],
  );

  return (
    <Stack spacing={1.5}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Group
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <Stack direction="row" spacing={1.5} alignItems="center">
        {room.group_id && (
          <Box
            sx={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              bgcolor: effectiveColor(room.group_id, byId),
              flexShrink: 0,
            }}
          />
        )}
        {canFile ? (
          <TextField
            select
            size="small"
            label="Group"
            value={room.group_id ?? ""}
            onChange={(e) => handleChange(e.target.value)}
            disabled={saving || !canWrite}
            sx={{ width: 320 }}
            helperText="Groups organise rooms in the list and colour them in the graph."
          >
            <MenuItem value="">Standalone (no group)</MenuItem>
            {choices.map(({ group, depth }) => (
              <MenuItem key={group.id} value={group.id}>
                {"  ".repeat(depth)}
                {group.name}
              </MenuItem>
            ))}
          </TextField>
        ) : (
          <>
            <Typography variant="body2">{currentName}</Typography>
            {room.group_id && canWrite && (
              <Button size="small" disabled={saving} onClick={() => handleChange("")}>
                Remove from group
              </Button>
            )}
          </>
        )}
      </Stack>
      {!canFile && (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          Only a workspace admin can put a room in a group.
        </Typography>
      )}
    </Stack>
  );
}
