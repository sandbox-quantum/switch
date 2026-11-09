import {
  Link,
  Box,
  Chip,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useMemo } from "react";
import { Link as RouterLink } from "react-router";
import { useHosted } from "../HostedContext";
import {
  LOAD_ERROR,
  STALE,
  type OverviewMachine,
  parseOverview,
  useOverviewRefresh,
} from "../overview/overview";

// p12's footnote, its first three sentences word for word. The fourth (shared
// services) is built from the answer rather than written down.
export const FOOTNOTE =
  "Used is what boxes are really using now; the alert fires above 85%. Booked is what boxes have reserved, a planning figure. A new machine stays closed until its three safety checks pass.";
export const HIGH = "Used memory above 85%";
export const EMPTY = "No machines yet.";

function Bar({ pct, label, colour }: { pct: number | null; label: string; colour: "primary" | "error" | "inherit" }) {
  return (
    <Box sx={{ minWidth: 160 }}>
      <LinearProgress
        variant="determinate"
        value={pct === null ? 0 : Math.min(100, pct)}
        color={colour}
        aria-label={label}
        sx={{ height: 8, borderRadius: 1 }}
      />
      <Typography variant="body2">{label}</Typography>
    </Box>
  );
}

function SafetyCheck({ machine }: { machine: OverviewMachine }) {
  if (machine.gate === "passed") return <Chip size="small" color="success" variant="outlined" label="Open" />;
  if (machine.gate === "failed")
    return <Chip size="small" color="error" variant="outlined" label="Safety check failed" />;
  const minutes = machine.heldMinutes === null ? "" : ` · ${machine.heldMinutes} min`;
  return <Chip size="small" color="warning" variant="outlined" label={`Safety check${minutes}`} />;
}

function usedLabel(pct: number | null): string {
  if (pct === null) return "Used —";
  // Over 85% but rounding down to 85 shows one decimal, so the figure never
  // contradicts the warning beside it (engineer-4).
  const over = pct > 85;
  // Rounded up to one decimal there, so 85.04 reads 85.1, never 85.0.
  const figure =
    over && Math.round(pct) <= 85 ? (Math.ceil(pct * 10) / 10).toFixed(1) : String(Math.round(pct));
  const shown = `Used ${figure}%`;
  return over ? `${shown} · ${HIGH}` : shown;
}

/** Switch web → Hosted → Machines (W4, p12). Read-only: it reads the
 *  overview the shell holds, and asks for a fresh one every 30 seconds. */
export default function MachinesTab() {
  const { overview: raw, overviewStale } = useHosted();
  useOverviewRefresh();
  const overview = useMemo(() => parseOverview(raw), [raw]);

  if (overview === null) {
    return (
      <Typography role="alert" color="error" sx={{ py: 2 }}>
        {LOAD_ERROR}
      </Typography>
    );
  }

  const services = overview.services
    .map((s) => `${s.name} ${s.ready} of ${s.wanted} ready`)
    .join(", ");

  return (
    <Stack spacing={1.5}>
      {(overviewStale || overview.reportStale) && (
        <Typography variant="body2" color="text.secondary">
          {STALE}
        </Typography>
      )}
      <Table size="small" aria-label="Machines">
        <TableHead>
          <TableRow>
            <TableCell>Machine</TableCell>
            <TableCell>Zone</TableCell>
            <TableCell>Memory used</TableCell>
            <TableCell>Memory booked</TableCell>
            <TableCell>Boxes</TableCell>
            <TableCell>Safety check</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {overview.machines.length === 0 && (
            <TableRow>
              <TableCell colSpan={6}>
                <Typography variant="body2" color="text.secondary">
                  {EMPTY}
                </Typography>
              </TableCell>
            </TableRow>
          )}
          {overview.machines.map((m) => (
            <TableRow key={m.name} data-testid="machine-row">
              <TableCell sx={{ fontWeight: 600 }}>
                {/* Its detail page, by the node's keyed id (when Core sends it). */}
                {m.machine ? (
                  <Link component={RouterLink} to={`/hosted/machines/${encodeURIComponent(m.machine)}`}>
                    {m.name}
                  </Link>
                ) : (
                  m.name
                )}
              </TableCell>
              <TableCell sx={{ color: "text.secondary", fontSize: 12, whiteSpace: "nowrap" }}>
                {m.zone}
              </TableCell>
              <TableCell>
                <Bar
                  pct={m.memoryUsedPct}
                  label={usedLabel(m.memoryUsedPct)}
                  colour={m.memoryUsedPct !== null && m.memoryUsedPct > 85 ? "error" : "primary"}
                />
              </TableCell>
              <TableCell>
                <Bar
                  pct={m.memoryBookedPct}
                  label={m.memoryBookedPct === null ? "Booked —" : `Booked ${Math.round(m.memoryBookedPct)}%`}
                  colour="inherit"
                />
              </TableCell>
              <TableCell>
                {m.roomForPeople === null ? m.boxes : `${m.boxes} of ${m.boxes + m.roomForPeople}`}
              </TableCell>
              <TableCell>
                <SafetyCheck machine={m} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Typography variant="body2" color="text.secondary" data-testid="machines-footnote">
        <b>Used</b>
        {FOOTNOTE.slice("Used".length, FOOTNOTE.indexOf("Booked"))}
        <b>Booked</b>
        {FOOTNOTE.slice(FOOTNOTE.indexOf("Booked") + "Booked".length)}
        {services ? ` Shared services: ${services}.` : ""}
      </Typography>
    </Stack>
  );
}
