import {
  Box,
  Chip,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";
import BoxActions from "../BoxActions";
import { useHosted } from "../HostedContext";
import PausedWithoutBox from "../PausedWithoutBox";
import { groupedId } from "../hostedActions";
import {
  type BoxState,
  LOAD_ERROR,
  STALE,
  gb,
  parseOverview,
  useOverviewRefresh,
} from "../overview/overview";
import ShowNameDialog, { type Revealed } from "./ShowNameDialog";

// Copy doc 2bcf4fb6, "Box state badges on Boxes (operators)". Retired boxes
// are hidden. No "Restarting" badge: Restarts today covers it.
export const BADGES: Record<
  Exclude<BoxState, "retired">,
  { label: string; color: "success" | "default" | "error" | "warning" }
> = {
  running: { label: "Running", color: "success" },
  resting: { label: "Resting", color: "default" },
  paused: { label: "Paused", color: "error" },
  starting: { label: "Starting", color: "warning" },
  stopping: { label: "Stopping", color: "warning" },
  stopped: { label: "Stopped", color: "default" },
  error: { label: "Can't start", color: "error" },
};
export const EMPTY = "No boxes yet.";

const MONO = { fontFamily: "monospace" };

/** A revealed name (never the email), or the Show name link. */
function Shown({ revealed, onAsk }: { revealed: Revealed | undefined; onAsk: () => void }) {
  if (revealed)
    return (
      <Typography component="span" data-testid="revealed-name">
        {revealed.name}
      </Typography>
    );
  return (
    <Link component="button" type="button" onClick={onAsk} sx={{ alignSelf: "flex-start" }}>
      Show name
    </Link>
  );
}

/** Switch web → Hosted → Boxes (W4, p10), with W6's actions in the last
 *  column and its paused-with-no-box list under the table. It reads the
 *  overview the shell holds, and asks for a fresh one every 30 seconds and
 *  after every action. A name from Show name is kept in this component's
 *  state only: it's gone on reload or when you leave the tab. */
export default function BoxesTab() {
  const { overview: raw, overviewStale, refresh } = useHosted();
  useOverviewRefresh();
  const overview = useMemo(() => parseOverview(raw), [raw]);
  const [asking, setAsking] = useState<{ kind: "user" | "workspace"; id: string } | null>(null);
  // Keyed by kind and id. A user has one box, so their name shows in one row;
  // a workspace's shows beside it wherever it appears.
  const [names, setNames] = useState<Record<string, Revealed>>({});
  const nameOf = (kind: "user" | "workspace", id: string) => names[`${kind}:${id}`];

  if (overview === null) {
    return (
      <Typography role="alert" color="error" sx={{ py: 2 }}>
        {LOAD_ERROR}
      </Typography>
    );
  }

  const zoneOf = new Map(overview.machines.map((m) => [m.name, m.zone]));
  const pausedOf = new Map(overview.people.map((p) => [p.userId, p.paused]));
  const shown = overview.boxes.filter((b) => b.state !== "retired");
  const onDone = () => void refresh();

  return (
    <Stack spacing={1.5}>
      {overviewStale && (
        <Typography variant="body2" color="text.secondary">
          {STALE}
        </Typography>
      )}
      {/* The table scrolls sideways rather than squeezing its cells onto two
          lines (designer). */}
      <Box sx={{ overflowX: "auto" }}>
      <Table size="small" aria-label="Boxes" sx={{ "& td, & th": { whiteSpace: "nowrap" } }}>
        <TableHead>
          <TableRow>
            <TableCell>Box</TableCell>
            <TableCell>Workspace</TableCell>
            <TableCell>User</TableCell>
            <TableCell>State</TableCell>
            <TableCell>Machine</TableCell>
            <TableCell>Memory</TableCell>
            <TableCell>Restarts today</TableCell>
            <TableCell aria-label="Actions" />
          </TableRow>
        </TableHead>
        <TableBody>
          {shown.length === 0 && (
            <TableRow>
              <TableCell colSpan={8}>
                <Typography variant="body2" color="text.secondary">
                  {EMPTY}
                </Typography>
              </TableCell>
            </TableRow>
          )}
          {shown.map((b) => {
            const badge = BADGES[b.state as Exclude<BoxState, "retired">];
            const zone = b.node === null ? undefined : zoneOf.get(b.node);
            const revealed = nameOf("user", b.user);
            const paused = pausedOf.get(b.user) ?? b.state === "paused";
            return (
              <TableRow key={b.box} data-testid="box-row">
                <TableCell sx={MONO}>{groupedId(b.box)}</TableCell>
                <TableCell>
                  {b.workspaces.map((w) => (
                    <Stack key={w} spacing={0.25} alignItems="flex-start" sx={{ mb: 0.5 }}>
                      <Typography component="span" sx={MONO}>
                        {groupedId(w)}
                      </Typography>
                      <Shown
                        revealed={nameOf("workspace", w)}
                        onAsk={() => setAsking({ kind: "workspace", id: w })}
                      />
                    </Stack>
                  ))}
                </TableCell>
                <TableCell>
                  <Stack spacing={0.25} alignItems="flex-start">
                    <Typography component="span" sx={MONO}>
                      {groupedId(b.user)}
                    </Typography>
                    <Shown revealed={revealed} onAsk={() => setAsking({ kind: "user", id: b.user })} />
                  </Stack>
                </TableCell>
                <TableCell>
                  <Chip size="small" label={badge.label} color={badge.color} variant="outlined" />
                </TableCell>
                <TableCell>
                  {b.node === null ? "—" : zone ? `${b.node} · ${zone}` : b.node}
                </TableCell>
                <TableCell>{b.memoryUsedBytes === null ? "—" : gb(b.memoryUsedBytes)}</TableCell>
                <TableCell>{b.restartsToday === null ? "—" : b.restartsToday}</TableCell>
                <TableCell align="right">
                  <BoxActions
                    userKeyedId={b.user}
                    boxKeyedId={b.box}
                    paused={paused}
                    running={b.state === "running"}
                    onDone={onDone}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      </Box>
      <PausedWithoutBox
        people={overview.people.map((p) => ({ user_id: p.userId, paused: p.paused }))}
        boxes={overview.boxes}
        onDone={onDone}
      />
      {asking !== null && (
        <ShowNameDialog
          kind={asking.kind}
          keyedId={asking.id}
          onCancel={() => setAsking(null)}
          onShown={(revealed) => {
            setNames((prev) => ({ ...prev, [`${asking.kind}:${asking.id}`]: revealed }));
            setAsking(null);
          }}
        />
      )}
    </Stack>
  );
}
