import { Box, LinearProgress, Link as MuiLink, Paper, Stack, Typography } from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { useHosted } from "../HostedContext";
import AlertTitle from "../w5shared/AlertTitle";
import IdCell from "../w5shared/IdCell";
import { shortTime } from "../w5shared/operatorFetch";
import AttentionAction from "./AttentionAction";
import {
  type Health,
  HEALTH_WORDS,
  ceilingLevel,
  ceilingWords,
  healthSummary,
  needsAttention,
  updatedWords,
} from "./health";
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
export const NEEDS_ATTENTION = "Needs attention";
export const NOTHING_NEEDS_ATTENTION = "No boxes need attention.";
export const HEALTH = "Health";
export const BOX_CEILING = "Boxes against the ceiling";

const DOT: Record<Health, string> = { green: "success.main", amber: "warning.main", red: "error.main" };

/** The clock, ticking each second while the browser tab is visible. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

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
 *  overview the shell holds, and asks for a fresh one every 15 seconds while
 *  the browser tab is visible. */
export default function OverviewTab() {
  const { overview: raw, overviewStale, overviewAt, refresh } = useHosted();
  useOverviewRefresh();
  const now = useNow();
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
  const attention = needsAttention(overview, now);
  const summary = healthSummary(overview, attention);
  const ceiling = overview.boxCeiling;
  const level = ceilingLevel(ceiling);

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2 }} component="section" aria-label={HEALTH}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Box
            aria-hidden
            data-testid="health-dot"
            data-health={summary.health}
            sx={{ width: 12, height: 12, borderRadius: "50%", bgcolor: DOT[summary.health], flexShrink: 0 }}
          />
          <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
            {HEALTH_WORDS[summary.health]}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {summary.counts} ·{" "}
            {summary.attention > 0 ? (
              <MuiLink href="#needs-attention" underline="always">
                {summary.verdict}
              </MuiLink>
            ) : (
              summary.verdict
            )}
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }} data-testid="updated">
          {overviewStale ? STALE : overviewAt ? updatedWords(overviewAt, now) : null}
        </Typography>
      </Paper>
      {ceiling && level && (
        <Paper variant="outlined" sx={{ p: 2 }} component="section" aria-label={BOX_CEILING}>
          <Typography variant="body2">{BOX_CEILING}</Typography>
          <LinearProgress
            variant="determinate"
            value={Math.min(100, (ceiling.made / ceiling.ceiling) * 100)}
            color={level === "full" ? "error" : level === "near" ? "warning" : "primary"}
            aria-label={BOX_CEILING}
            aria-valuetext={`${ceiling.made} of ${ceiling.ceiling} boxes`}
            sx={{ my: 1, height: 8, borderRadius: 4 }}
          />
          <Typography
            variant="body2"
            color={level === "full" ? "error" : level === "near" ? "warning.main" : "text.secondary"}
          >
            {ceilingWords(ceiling)}
          </Typography>
        </Paper>
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
      <Paper
        variant="outlined"
        sx={{ p: 2 }}
        component="section"
        aria-label={NEEDS_ATTENTION}
        id="needs-attention"
      >
        <Typography variant="subtitle2" component="h2" gutterBottom>
          {NEEDS_ATTENTION}
        </Typography>
        {attention.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {NOTHING_NEEDS_ATTENTION}
          </Typography>
        ) : (
          <Stack spacing={1}>
            {attention.map((row) => (
              <Stack
                key={row.box.box}
                direction="row"
                spacing={1}
                alignItems="center"
                data-testid={`attention-${row.box.box}`}
              >
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                  <Typography variant="body2" color={row.severity === "red" ? "error" : "warning.main"}>
                    {row.words}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Box <IdCell id={row.box.box} label="box" /> · user{" "}
                    <IdCell id={row.box.user} label="user" />
                  </Typography>
                </Box>
                <AttentionAction row={row} onDone={() => void refresh()} />
              </Stack>
            ))}
          </Stack>
        )}
      </Paper>
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
