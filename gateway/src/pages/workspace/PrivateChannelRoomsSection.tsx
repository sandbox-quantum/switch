import {
  Alert,
  Button,
  Checkbox,
  CircularProgress,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { Link as RouterLink } from "react-router";
import ConfirmDialog from "../../components/ConfirmDialog";
import {
  type MakeRoomsPrivateResult,
  type PrivateChannelRoom,
  type PrivateChannelRoomCaution,
  makeRoomsPrivate,
  previewPrivateChannelRooms,
} from "../../data/api";
import { platformLabel } from "../../theme/format";

const CHANNEL_LABELS: Record<string, string> = {
  channel_private: "Private channel",
  group: "Group",
  direct: "Direct message",
};

export function channelLabel(channelType: string | null): string {
  if (channelType === null) return "Unknown, check by hand";
  return CHANNEL_LABELS[channelType] ?? channelType;
}

export const CAUTION_TEXT: Record<PrivateChannelRoomCaution, string> = {
  members_not_listed:
    "This app can't list the channel's members, so people in it who never posted aren't in the room and would lose sight of it.",
  channel_type_unknown:
    "Switch doesn't know what kind of channel this is and the app couldn't say. Check it's private before ticking.",
  bridge_not_connected:
    "This room's app isn't connected right now, so Switch couldn't check the channel.",
};

const SKIP_TEXT: Record<string, string> = {
  not_found: "no longer exists",
  already_private: "was already Private",
  archived: "was archived",
  not_eligible: "is no longer on a private channel",
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function describeResult(
  result: MakeRoomsPrivateResult,
  names: Map<string, string>,
): string {
  const parts = [`Made ${plural(result.changed.length, "room", "rooms")} Private.`];
  for (const skip of result.skipped) {
    const name = names.get(skip.room_id) ?? skip.room_id;
    parts.push(`${name} was skipped: it ${SKIP_TEXT[skip.reason] ?? skip.reason}.`);
  }
  return parts.join(" ");
}

function RoomRow({
  room,
  checked,
  onToggle,
}: {
  room: PrivateChannelRoom;
  checked: boolean;
  onToggle: () => void;
}) {
  const app = room.bridge_name ?? platformLabel(room.bridge_type ?? "");
  return (
    <TableRow hover>
      <TableCell padding="checkbox">
        <Checkbox
          checked={checked}
          onChange={onToggle}
          slotProps={{ input: { "aria-label": `Make ${room.name} Private` } }}
        />
      </TableCell>
      <TableCell>
        <Stack spacing={0.5}>
          <Link component={RouterLink} to={`/rooms/${room.room_id}`}>
            {room.name}
          </Link>
          {room.cautions.map((caution) => (
            <Typography key={caution} variant="caption" sx={{ color: "warning.main" }}>
              {CAUTION_TEXT[caution]}
            </Typography>
          ))}
        </Stack>
      </TableCell>
      <TableCell>{app}</TableCell>
      <TableCell>{channelLabel(room.channel_type)}</TableCell>
      <TableCell align="right">{room.people}</TableCell>
    </TableRow>
  );
}

/** Make Public rooms on private channels Private: check first (changes
 * nothing), tick, confirm. Rooms that need a second look start unticked. */
export default function PrivateChannelRoomsSection({ tenantId }: { tenantId: string }) {
  const [rooms, setRooms] = useState<PrivateChannelRoom[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const found = await previewPrivateChannelRooms(tenantId);
      setRooms(found);
      setSelected(new Set(found.filter((r) => r.recommended).map((r) => r.room_id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check the rooms");
    } finally {
      setChecking(false);
    }
  };

  const toggle = (roomId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(roomId)) next.delete(roomId);
      else next.add(roomId);
      return next;
    });
  };

  const apply = async () => {
    const names = new Map((rooms ?? []).map((r) => [r.room_id, r.name]));
    const outcome = await makeRoomsPrivate(tenantId, [...selected]);
    setConfirming(false);
    setResult(describeResult(outcome, names));
    await check();
  };

  const count = selected.size;
  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">Public rooms on private channels</Typography>
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {result && (
        <Alert severity="success" onClose={() => setResult(null)}>
          {result}
        </Alert>
      )}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            Rooms made before rooms followed their channel can be Public while their channel is
            private, so everyone in the workspace can read that channel in Switch. Check lists
            them without changing anything. Making a room Private leaves its channel as it is,
            and adds a line to the room saying a workspace admin changed it.
          </Typography>
          {rooms === null ? (
            <Stack direction="row">
              <Button variant="outlined" onClick={check} disabled={checking}>
                {checking ? <CircularProgress size={20} /> : "Check rooms"}
              </Button>
            </Stack>
          ) : rooms.length === 0 ? (
            <Typography variant="body2">
              No Public rooms on private channels. Nothing to change.
            </Typography>
          ) : (
            <>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox" />
                    <TableCell>Room</TableCell>
                    <TableCell>App</TableCell>
                    <TableCell>Channel</TableCell>
                    <TableCell align="right">People</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rooms.map((room) => (
                    <RoomRow
                      key={room.room_id}
                      room={room}
                      checked={selected.has(room.room_id)}
                      onToggle={() => toggle(room.room_id)}
                    />
                  ))}
                </TableBody>
              </Table>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                People counts who Switch knows is in each room. On apps that can&apos;t list a
                channel&apos;s members, people who never posted aren&apos;t counted.
              </Typography>
              <Stack direction="row" spacing={1.5}>
                <Button
                  variant="contained"
                  disabled={count === 0}
                  onClick={() => setConfirming(true)}
                >
                  {`Make ${plural(count, "room", "rooms")} Private`}
                </Button>
                <Button onClick={check} disabled={checking}>
                  Check again
                </Button>
              </Stack>
            </>
          )}
        </Stack>
      </Paper>
      <ConfirmDialog
        open={confirming}
        title={`Make ${plural(count, "room", "rooms")} Private?`}
        description="Only the people in each room will see it in Switch. The channels aren't changed. A room's owner or an admin can make it Public again in its settings."
        confirmLabel="Make Private"
        tone="plain"
        onConfirm={apply}
        onClose={() => setConfirming(false)}
      />
    </Stack>
  );
}
