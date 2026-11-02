import { Box, Paper, Stack, Typography } from "@mui/material";
import { useMemo } from "react";
import { useHosted } from "../HostedContext";
import AlertTitle from "../w5shared/AlertTitle";
import { shortTime } from "../w5shared/operatorFetch";
import {
  LOAD_ERROR,
  STALE,
  type Overview,
  gb,
  isolationVerdict,
  parseOverview,
  useOverviewRefresh,
} from "./overview";

// p16, at V0. "Waiting for room" waits for a V4 field, so it isn't shown.
export const OPEN_NOW = "Open now";
export const NOTHING_OPEN = "No alerts right now."; // copy doc 2bcf4fb6, as on the Alerts tab

function Card({
  label,
  value,
  beside,
  line,
  alert,
}: {
  label: string;
  value: string;
  /** Words next to the figure, so a mark never carries the meaning alone. */
  beside?: string;
  line: string;
  alert?: boolean | "warning";
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2, flex: "1 1 160px", minWidth: 160 }} aria-label={label}>
      <Typography variant="body2">{label}</Typography>
      <Stack direction="row" spacing={1} alignItems="baseline">
        <Typography variant="h4" component="p" sx={{ fontWeight: 600 }}>
          {value}
        </Typography>
        {beside && (
          <Typography
            variant="body2"
            color={alert === "warning" ? "warning.main" : alert ? "error" : undefined}
          >
            {beside}
          </Typography>
        )}
      </Stack>
      <Typography variant="body2" color={alert === true ? "error" : "text.secondary"}>
        {line}
      </Typography>
    </Paper>
  );
}

/** Memory in use across machines: used over total when every machine reports
 *  its total, otherwise the plain average of their percentages. */
function memory(overview: Overview): { value: string; line: string } {
  const known = overview.machines.filter((m) => m.memoryUsedPct !== null);
  if (known.length === 0) return { value: "—", line: "Not reported yet" };
  const totals = known.map((m) => m.memoryTotalBytes);
  if (totals.every((t): t is number => t !== null && t > 0)) {
    const total = totals.reduce((a, b) => a + b, 0);
    const used = known.reduce((a, m, i) => a + ((m.memoryUsedPct ?? 0) / 100) * totals[i], 0);
    return { value: `${Math.round((used / total) * 100)}%`, line: `of ${gb(total).replace(".0 ", " ")}` };
  }
  const mean = Math.round(known.reduce((a, m) => a + (m.memoryUsedPct ?? 0), 0) / known.length);
  const machines = known.length === 1 ? "1 machine" : `${known.length} machines`;
  return { value: `${mean}%`, line: `Average ${mean}% across ${machines}` };
}

function keptApart(overview: Overview): {
  value: string;
  beside?: string;
  line: string;
  alert: boolean | "warning";
} {
  const { checkedAt, cells, total } = overview.isolation;
  const when = checkedAt ? shortTime(checkedAt) : null;
  // The tab's own rule, so the card and the tab never disagree (copy doc 3cb588ca).
  const v = isolationVerdict(cells, total);
  if (checkedAt === null || v.kind === "none") return { value: "—", line: "Not checked yet", alert: false };
  if (v.kind === "pass")
    return {
      value: "✓",
      beside: `Passed · ${v.blocked} of ${v.attempts} blocked`,
      line: when ? `checked ${when}` : "checked",
      alert: false,
    };
  if (v.kind === "fail")
    return {
      value: "✗",
      beside: `Failed · ${v.blocked} of ${v.attempts} blocked`,
      line: when ? `Check failed at ${when}` : "Check failed",
      alert: true,
    };
  return {
    value: "!",
    beside: `Not confirmed · ${v.couldntRun} couldn't run`,
    line: when ? `checked ${when}` : "checked",
    alert: "warning",
  };
}

/** Switch web → Hosted → Overview (W4, p16 at V0). Read-only: it reads the
 *  overview the shell holds, and asks for a fresh one every 30 seconds. */
export default function OverviewTab() {
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

  const agents = overview.people.reduce((a, p) => a + p.agents, 0);
  const zones = new Set(overview.machines.map((m) => m.zone)).size;
  const mem = memory(overview);
  const apart = keptApart(overview);
  const open = overview.alerts.filter((a) => a.open);
  const critical = open.filter((a) => a.severity === "critical").length;

  return (
    <Stack spacing={2}>
      {overviewStale && (
        <Typography variant="body2" color="text.secondary">
          {STALE}
        </Typography>
      )}
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5 }}>
        <Card
          label="People"
          value={String(overview.people.length)}
          line={`${agents} ${agents === 1 ? "agent" : "agents"}`}
        />
        <Card
          label="Machines"
          value={String(overview.machines.length)}
          line={`${zones} ${zones === 1 ? "zone" : "zones"}`}
        />
        <Card label="Memory in use" value={mem.value} line={mem.line} />
        <Card
          label="Kept apart"
          value={apart.value}
          beside={apart.beside}
          line={apart.line}
          alert={apart.alert}
        />
        <Card
          label="Alerts open"
          value={String(open.length)}
          line={
            critical > 0
              ? `${critical} critical`
              : open.length > 0
                ? `${open.length} open · none critical`
                : NOTHING_OPEN
          }
          alert={critical > 0}
        />
      </Box>
      <Paper variant="outlined" sx={{ p: 2 }} component="section" aria-label={OPEN_NOW}>
        <Typography variant="subtitle2" component="h2" gutterBottom>
          {OPEN_NOW}
        </Typography>
        {open.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {NOTHING_OPEN}
          </Typography>
        ) : (
          open.map((a, i) => (
            <Typography key={i} variant="body2">
              {a.severity === "critical" ? "Critical" : "Warning"} · <AlertTitle title={a.title} />
              {a.raisedAt ? ` · ${shortTime(a.raisedAt)}` : ""}
            </Typography>
          ))
        )}
      </Paper>
    </Stack>
  );
}
