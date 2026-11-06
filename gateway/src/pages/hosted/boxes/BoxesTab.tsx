import SearchIcon from "@mui/icons-material/Search";
import {
  Box,
  Chip,
  InputAdornment,
  LinearProgress,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { useMemo, useState } from "react";
import { Link as RouterLink, useSearchParams } from "react-router";
import { capacityStep } from "../../agents/cloud/capacity";
import BoxActions from "../BoxActions";
import { useHosted } from "../HostedContext";
import PausedWithoutBox from "../PausedWithoutBox";
import {
  type BoxState,
  LOAD_ERROR,
  type OverviewBox,
  STALE,
  gb,
  parseOverview,
  useOverviewRefresh,
} from "../overview/overview";
import IdCell from "../w5shared/IdCell";
import {
  BOX_FILTERS,
  type BoxFilter,
  filterBoxes,
  filterCounts,
  isCurrent,
  keptUntil,
} from "../w5shared/boxFilter";
import ShowNameDialog, { type Revealed } from "./ShowNameDialog";

// Copy doc 2bcf4fb6, "Box state badges on Boxes (operators)". A put-away
// (retired) box has its own greyed label. No "Restarting" badge: Restarts
// today covers it.
export const BADGES: Record<
  BoxState,
  { label: string; color: "success" | "default" | "error" | "warning" }
> = {
  running: { label: "Running", color: "success" },
  resting: { label: "Resting", color: "default" },
  paused: { label: "Paused", color: "error" },
  starting: { label: "Starting", color: "warning" },
  stopping: { label: "Stopping", color: "warning" },
  stopped: { label: "Stopped", color: "default" },
  error: { label: "Can't start", color: "error" },
  retired: { label: "Put away", color: "default" },
};
export const EMPTY = "No boxes yet.";
export const NO_MATCH = "No boxes match these filters.";
const FILTER_VALUES = new Set<string>(BOX_FILTERS.map((f) => f.value));

/** Awake agents as the panel words it: "3 of 12 awake". */
export function awakeText(box: OverviewBox): string {
  return box.awake === null ? "—" : `${box.awake.running} of ${box.awake.max} awake`;
}

/** The agents' workspace disk in use, out of its size: shown only when the box
 *  marks its figure as the workspace disk, so the system disk never shows. */
export const DISK_NOT_AVAILABLE = "Not available";
export function diskText(box: OverviewBox): string {
  const disk = box.workspaceDisk;
  if (!disk) return DISK_NOT_AVAILABLE;
  return `${gb(disk.totalBytes - disk.availableBytes)} of ${gb(disk.totalBytes)}`;
}

const BAR_COLOUR = { ok: "primary", nearly_full: "warning", full: "error" } as const;

/** A figure with a thin bar under it, coloured by the same steps as Your
 *  cloud (amber at 80%, red at 95%). No bar when there's no share to show;
 *  the figure is always in the text, so nothing depends on colour. */
export function CapacityCell({ text, share, name }: { text: string; share: number | null; name: string }) {
  const step = share === null ? null : capacityStep(share);
  return (
    <Box data-capacity={name} data-step={step ?? "none"} sx={{ minWidth: 96 }}>
      {text}
      {step !== null && share !== null && (
        <LinearProgress
          variant="determinate"
          value={Math.min(100, share * 100)}
          color={BAR_COLOUR[step]}
          aria-hidden
          sx={{ mt: 0.5, height: 4, borderRadius: 2, maxWidth: 120 }}
        />
      )}
    </Box>
  );
}

/** Each figure's share of its limit, or null when either side is missing. */
export function shares(box: OverviewBox): { awake: number | null; memory: number | null; disk: number | null } {
  const disk = box.workspaceDisk;
  return {
    awake: box.awake === null ? null : box.awake.running / box.awake.max,
    memory:
      box.memoryUsedBytes === null || box.memoryTotalBytes === null
        ? null
        : box.memoryUsedBytes / box.memoryTotalBytes,
    disk: disk ? (disk.totalBytes - disk.availableBytes) / disk.totalBytes : null,
  };
}

/** Memory in use, and out of the box's memory when Core sends it. */
export function memoryText(box: OverviewBox): string {
  if (box.memoryUsedBytes === null) return "—";
  return box.memoryTotalBytes === null
    ? gb(box.memoryUsedBytes)
    : `${gb(box.memoryUsedBytes)} of ${gb(box.memoryTotalBytes)}`;
}

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
/** Below this width the Workspace column goes (it's on the box page), so the
 *  table fits an ordinary laptop screen (1440 px). */
export const NARROW = "(max-width:1599.95px)";

/** The actions column stays pinned at the right edge while the table scrolls
 *  sideways, so Resume, Pause and Restart are always in reach. */
const PINNED_SX = {
  position: "sticky",
  right: 0,
  zIndex: 1,
  bgcolor: "background.paper",
  boxShadow: "inset 1px 0 0 rgba(0, 0, 0, 0.12)",
} as const;

export default function BoxesTab() {
  const { overview: raw, overviewStale, refresh } = useHosted();
  useOverviewRefresh();
  const narrow = useMediaQuery(NARROW);
  const overview = useMemo(() => parseOverview(raw), [raw]);
  const [asking, setAsking] = useState<{ kind: "user" | "workspace"; id: string } | null>(null);
  // Keyed by kind and id. A user has one box, so their name shows in one row;
  // a workspace's shows beside it wherever it appears.
  const [names, setNames] = useState<Record<string, Revealed>>({});
  const nameOf = (kind: "user" | "workspace", id: string) => names[`${kind}:${id}`];
  // The filters live in the address, so a filtered view can be shared or reloaded.
  const [params, setParams] = useSearchParams();
  const stateParam = params.get("state") ?? "current";
  const filter: BoxFilter = FILTER_VALUES.has(stateParam) ? (stateParam as BoxFilter) : "current";
  const query = params.get("q") ?? "";
  const setFilter = (next: { state?: BoxFilter; q?: string }) => {
    const updated = new URLSearchParams(params);
    const state = next.state ?? filter;
    const q = next.q ?? query;
    if (state === "current") updated.delete("state");
    else updated.set("state", state);
    if (q) updated.set("q", q);
    else updated.delete("q");
    setParams(updated, { replace: true });
  };

  if (overview === null) {
    return (
      <Typography role="alert" color="error" sx={{ py: 2 }}>
        {LOAD_ERROR}
      </Typography>
    );
  }

  const machineOf = new Map(overview.machines.map((m) => [m.name, m]));
  const pausedOf = new Map(overview.people.map((p) => [p.userId, p.paused]));
  const counts = filterCounts(overview.boxes);
  const shown = filterBoxes(overview.boxes, filter, query);
  const onDone = () => void refresh();

  return (
    <Stack spacing={1.5}>
      {overviewStale && (
        <Typography variant="body2" color="text.secondary">
          {STALE}
        </Typography>
      )}
      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={1.5}
        alignItems={{ md: "center" }}
        justifyContent="space-between"
      >
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap role="group" aria-label="Box state">
          {BOX_FILTERS.map((f) => (
            <Chip
              key={f.value}
              label={`${f.label} ${counts[f.value]}`}
              color={filter === f.value ? "primary" : "default"}
              variant={filter === f.value ? "filled" : "outlined"}
              onClick={() => setFilter({ state: f.value })}
              aria-pressed={filter === f.value}
            />
          ))}
        </Stack>
        <TextField
          size="small"
          placeholder="Search ids or machine"
          value={query}
          onChange={(e) => setFilter({ q: e.target.value })}
          inputProps={{ "aria-label": "Search boxes" }}
          sx={{ minWidth: 260 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
      </Stack>
      {/* The table scrolls sideways rather than squeezing its cells onto two
          lines (designer), with the actions pinned at the right. Headings may
          wrap ("Restarts today"); cells don't. */}
      <Box sx={{ overflowX: "auto", maxWidth: "100%" }} data-testid="boxes-frame">
      <Table size="small" aria-label="Boxes" sx={{ "& td": { whiteSpace: "nowrap" } }}>
        <TableHead>
          <TableRow>
            <TableCell>Box</TableCell>
            {!narrow && <TableCell>Workspace</TableCell>}
            <TableCell>Person</TableCell>
            <TableCell>State</TableCell>
            <TableCell>Machine</TableCell>
            <TableCell>Agents</TableCell>
            <TableCell>Memory</TableCell>
            <TableCell>Disk</TableCell>
            <TableCell align="right">Restarts today</TableCell>
            <TableCell aria-label="Actions" data-pinned sx={PINNED_SX} />
          </TableRow>
        </TableHead>
        <TableBody>
          {shown.length === 0 && (
            <TableRow>
              <TableCell colSpan={narrow ? 9 : 10}>
                <Typography variant="body2" color="text.secondary">
                  {overview.boxes.length === 0 ? EMPTY : NO_MATCH}
                </Typography>
              </TableCell>
            </TableRow>
          )}
          {shown.map((b) => {
            const badge = BADGES[b.state];
            const machine = b.node === null ? undefined : machineOf.get(b.node);
            const revealed = nameOf("user", b.user);
            const paused = pausedOf.get(b.user) ?? b.state === "paused";
            const current = isCurrent(b);
            const kept = current ? null : keptUntil(b.retainUntil);
            const share = shares(b);
            return (
              <TableRow
                key={b.box}
                data-testid="box-row"
                // Put-away boxes are greyed, so they never read as live ones.
                sx={current ? undefined : { opacity: 0.6, bgcolor: "action.hover" }}
              >
                <TableCell>
                  <Stack direction="row" alignItems="center" spacing={0.5}>
                    <IdCell id={b.box} label="box" />
                    <Link
                      component={RouterLink}
                      to={`/hosted/boxes/${encodeURIComponent(b.box)}`}
                      variant="body2"
                    >
                      Open
                    </Link>
                  </Stack>
                </TableCell>
                {!narrow && (
                  <TableCell>
                    {b.workspaces.map((w) => (
                      <Stack key={w} spacing={0.25} alignItems="flex-start" sx={{ mb: 0.5 }}>
                        <IdCell id={w} label="workspace" />
                        <Shown
                          revealed={nameOf("workspace", w)}
                          onAsk={() => setAsking({ kind: "workspace", id: w })}
                        />
                      </Stack>
                    ))}
                  </TableCell>
                )}
                <TableCell>
                  <Stack spacing={0.25} alignItems="flex-start">
                    <IdCell id={b.user} label="person" />
                    <Shown revealed={revealed} onAsk={() => setAsking({ kind: "user", id: b.user })} />
                  </Stack>
                </TableCell>
                <TableCell>
                  <Stack spacing={0.25} alignItems="flex-start">
                    <Chip size="small" label={badge.label} color={badge.color} variant="outlined" />
                    {kept && (
                      <Typography variant="caption" color="text.secondary">
                        {kept}
                      </Typography>
                    )}
                  </Stack>
                </TableCell>
                <TableCell>
                  {b.node === null ? (
                    "—"
                  ) : machine?.machine ? (
                    <Link
                      component={RouterLink}
                      to={`/hosted/machines/${encodeURIComponent(machine.machine)}`}
                    >
                      {machine.zone ? `${b.node} · ${machine.zone}` : b.node}
                    </Link>
                  ) : machine?.zone ? (
                    `${b.node} · ${machine.zone}`
                  ) : (
                    b.node
                  )}
                </TableCell>
                <TableCell>
                  <CapacityCell name="awake" text={awakeText(b)} share={share.awake} />
                </TableCell>
                <TableCell>
                  <CapacityCell name="memory" text={memoryText(b)} share={share.memory} />
                </TableCell>
                <TableCell sx={b.workspaceDisk ? undefined : { color: "text.secondary" }}>
                  <CapacityCell name="disk" text={diskText(b)} share={share.disk} />
                </TableCell>
                <TableCell align="right">{b.restartsToday === null ? "—" : b.restartsToday}</TableCell>
                <TableCell align="right" data-pinned sx={PINNED_SX}>
                  {current && (
                    <BoxActions
                      userKeyedId={b.user}
                      boxKeyedId={b.box}
                      paused={paused}
                      running={b.state === "running"}
                      onDone={onDone}
                    />
                  )}
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
