import ArrowBack from "@mui/icons-material/ArrowBack";
import {
  Alert,
  Box,
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
  TablePagination,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useCallback, useMemo, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router";
import ConfirmDialog from "../../components/ConfirmDialog";
import {
  type AskPlatformResult,
  MAKE_PRIVATE_MAX,
  type MakeRoomsPrivateResult,
  type PrivateChannelRoom,
  type PrivateChannelRoomCaution,
  askPlatformAboutRooms,
  makeRoomsPrivate,
  previewPrivateChannelRooms,
} from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { platformLabel } from "../../theme/format";
import { useLoad } from "./useLoad";

const CHANNEL_LABELS: Record<string, string> = {
  channel_private: "Private channel",
  group: "Group",
  direct: "Direct message",
};

export function channelLabel(channelType: string | null): string {
  if (channelType === null) return "Not recorded";
  return CHANNEL_LABELS[channelType] ?? channelType;
}

export const CAUTION_TEXT: Record<PrivateChannelRoomCaution, string> = {
  members_not_listed:
    "This app can't list the channel's members, so people in it who never posted aren't in the room and would lose sight of it.",
  channel_type_not_recorded:
    "Switch has no record of what kind of channel this is. Ask the app, or check it's private before ticking.",
  bridge_not_connected: "This room's app isn't connected right now.",
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

export function describeAsk(result: AskPlatformResult): string {
  const parts: string[] = [];
  if (result.answered.length) {
    parts.push(`Recorded the channel type of ${plural(result.answered.length, "room", "rooms")}.`);
  }
  const unsure = result.unanswered.filter((u) => u.reason === "could_not_tell").length;
  if (unsure) parts.push(`The app couldn't say for ${plural(unsure, "room", "rooms")}; check those by hand.`);
  const offline = result.unanswered.length - unsure;
  if (offline) parts.push(`${plural(offline, "room's app isn't", "rooms' apps aren't")} connected.`);
  if (result.stopped === "rate_limited") {
    parts.push("The app asked Switch to slow down, so it stopped there. Try again in a minute.");
  } else if (result.stopped === "timed_out") {
    parts.push("The app was slow to answer, so it stopped there. Try again shortly.");
  }
  if (!parts.length) parts.push("Nothing to ask about.");
  return parts.join(" ");
}

type Filter = "all" | "ready" | "check";

function matches(room: PrivateChannelRoom, filter: Filter, search: string): boolean {
  if (filter === "ready" && !room.recommended) return false;
  if (filter === "check" && room.recommended) return false;
  if (!search) return true;
  const needle = search.toLocaleLowerCase();
  return (
    room.name.toLocaleLowerCase().includes(needle) ||
    (room.bridge_name ?? "").toLocaleLowerCase().includes(needle)
  );
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

/** Review Public rooms on private channels and make the ticked ones Private.
 * Rooms that need a second look start unticked. Reads only Switch's records;
 * the apps are asked only about rooms of unrecorded type, and only when the
 * admin asks. */
export default function PrivateChannelRoomsPage() {
  const { session } = useAuth();
  const tenantId = session?.tenant?.id ?? "";
  const navigate = useNavigate();
  const load = useCallback(() => previewPrivateChannelRooms(tenantId), [tenantId]);
  const { data: rooms, error, loading, refetch } = useLoad(load);

  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const all = useMemo(() => rooms ?? [], [rooms]);
  // Until the admin ticks or unticks anything, the ready rooms are ticked.
  const ticked = useMemo(
    () => selected ?? new Set(all.filter((r) => r.recommended).map((r) => r.room_id)),
    [selected, all],
  );
  const shown = useMemo(() => all.filter((r) => matches(r, filter, search)), [all, filter, search]);
  const pageRows = shown.slice(page * rowsPerPage, (page + 1) * rowsPerPage);
  const ready = all.filter((r) => r.recommended).length;
  const unrecorded = all.filter((r) => r.channel_type === null).length;
  const count = ticked.size;
  const tooMany = count > MAKE_PRIVATE_MAX;

  const toggle = (roomId: string) => {
    const next = new Set(ticked);
    if (next.has(roomId)) next.delete(roomId);
    else next.add(roomId);
    setSelected(next);
  };
  const shownTicked = shown.length > 0 && shown.every((r) => ticked.has(r.room_id));
  const toggleShown = () => {
    const next = new Set(ticked);
    for (const room of shown) {
      if (shownTicked) next.delete(room.room_id);
      else next.add(room.room_id);
    }
    setSelected(next);
  };

  const reload = async () => {
    setSelected(null);
    await refetch();
  };

  const apply = async () => {
    const names = new Map(all.map((r) => [r.room_id, r.name]));
    const outcome = await makeRoomsPrivate(tenantId, [...ticked]);
    setConfirming(false);
    // The list first, so the message never sits over rooms it says changed.
    await reload();
    setNotice(describeResult(outcome, names));
  };

  const ask = async () => {
    setAsking(true);
    setActionError(null);
    try {
      const outcome = await askPlatformAboutRooms(tenantId);
      await reload();
      setNotice(describeAsk(outcome));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not ask the apps");
    } finally {
      setAsking(false);
    }
  };

  return (
    <Box sx={{ pb: 10 }}>
      <Button startIcon={<ArrowBack />} onClick={() => navigate(-1)} sx={{ mb: 1 }}>
        Back
      </Button>
      <Typography variant="h5" mb={1}>
        Public rooms on private channels
      </Typography>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 3, maxWidth: 820 }}>
        These rooms are Public in Switch, so everyone in the workspace can read them, but their
        channel is private. Making a room Private leaves its channel as it is, and adds a line to
        the room saying a workspace admin changed it. Rooms that need a second look start
        unticked.
      </Typography>
      <Stack spacing={2}>
        {error && <Alert severity="error">{error}</Alert>}
        {actionError && (
          <Alert severity="error" onClose={() => setActionError(null)}>
            {actionError}
          </Alert>
        )}
        {notice && (
          <Alert severity="info" onClose={() => setNotice(null)}>
            {notice}
          </Alert>
        )}
        {loading ? (
          <CircularProgress />
        ) : error ? null : all.length === 0 ? (
          <Typography variant="body2">
            No Public rooms on private channels. Nothing to change.
          </Typography>
        ) : (
          <>
            {unrecorded > 0 && (
              <Alert
                severity="warning"
                action={
                  <Button color="inherit" size="small" onClick={ask} disabled={asking}>
                    {asking ? <CircularProgress size={18} /> : "Ask the apps"}
                  </Button>
                }
              >
                Switch has no record of the channel type for{" "}
                {plural(unrecorded, "room", "rooms")}. Ask their apps about up to 20 at a time;
                the answers are saved.
              </Alert>
            )}
            <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
              <TextField
                size="small"
                label="Search rooms"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
              />
              <ToggleButtonGroup
                size="small"
                exclusive
                value={filter}
                onChange={(_, value: Filter | null) => {
                  if (value) {
                    setFilter(value);
                    setPage(0);
                  }
                }}
              >
                <ToggleButton value="all">{`All (${all.length})`}</ToggleButton>
                <ToggleButton value="ready">{`Ready (${ready})`}</ToggleButton>
                <ToggleButton value="check">{`Needs a check (${all.length - ready})`}</ToggleButton>
              </ToggleButtonGroup>
            </Stack>
            <Paper variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={shownTicked}
                        indeterminate={!shownTicked && shown.some((r) => ticked.has(r.room_id))}
                        onChange={toggleShown}
                        slotProps={{ input: { "aria-label": "Tick every room shown" } }}
                      />
                    </TableCell>
                    <TableCell>Room</TableCell>
                    <TableCell>App</TableCell>
                    <TableCell>Channel</TableCell>
                    <TableCell align="right">People</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {pageRows.map((room) => (
                    <RoomRow
                      key={room.room_id}
                      room={room}
                      checked={ticked.has(room.room_id)}
                      onToggle={() => toggle(room.room_id)}
                    />
                  ))}
                </TableBody>
              </Table>
              <TablePagination
                component="div"
                count={shown.length}
                page={page}
                onPageChange={(_, next) => setPage(next)}
                rowsPerPage={rowsPerPage}
                onRowsPerPageChange={(event) => {
                  setRowsPerPage(Number(event.target.value));
                  setPage(0);
                }}
                rowsPerPageOptions={[25, 50, 100]}
              />
            </Paper>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              People counts who Switch knows is in each room. On apps that can&apos;t list a
              channel&apos;s members, people who never posted aren&apos;t counted.
            </Typography>
          </>
        )}
      </Stack>
      {all.length > 0 && (
        <Paper
          elevation={3}
          sx={{
            position: "sticky",
            bottom: 16,
            mt: 2,
            p: 1.5,
            display: "flex",
            alignItems: "center",
            gap: 2,
          }}
        >
          <Typography variant="body2" sx={{ flex: 1 }}>
            {tooMany
              ? `${plural(count, "room", "rooms")} ticked. Make at most ${MAKE_PRIVATE_MAX} Private at a time.`
              : `${plural(count, "room", "rooms")} ticked.`}
          </Typography>
          <Button
            variant="contained"
            disabled={count === 0 || tooMany}
            onClick={() => setConfirming(true)}
          >
            {`Make ${plural(count, "room", "rooms")} Private`}
          </Button>
        </Paper>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Make ${plural(count, "room", "rooms")} Private?`}
        description="Only the people in each room will see it in Switch. The channels aren't changed. A room's owner or an admin can make it Public again in its settings."
        confirmLabel="Make Private"
        tone="plain"
        onConfirm={apply}
        onClose={() => setConfirming(false)}
      />
    </Box>
  );
}
