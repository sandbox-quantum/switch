import {
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useMemo } from "react";
import { useHosted } from "../HostedContext";
import { LOAD_ERROR, STALE, isolationVerdict, useOverviewRefresh } from "../overview/overview";
import { isRecord, shortTime, stringOrNull } from "../w5shared/operatorFetch";

// The words of Console's built Isolation tab (shared-cloud-admin.tsx), so the
// two say the same thing.
export const NOT_RUN = "No isolation check has run yet, or its result can't be read right now.";
export const HOW = "Each person's agents tried to reach the other person's, in both directions.";
// Copy doc 3cb588ca: when none got through but some couldn't run, it must look
// unfinished, not safe.
export const NOT_CONFIRMED_LINE = "None got through, but these weren't tested.";

type Result = "pass" | "fail" | "unknown";

interface Attempt {
  label: string;
  results: { direction: string; result: Result }[];
}

interface Isolation {
  result: Result;
  blocked: number;
  total: number;
  checkedAt: string | null;
  attempts: Attempt[];
}

function result(value: unknown): Result {
  return value === "pass" || value === "fail" ? value : "unknown";
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** V4's `isolation`, checked field by field. An attempt with anything else in
 *  it is dropped, never shown half-read. A missing `isolation` is an error. */
export function parseIsolation(raw: unknown): Isolation | null {
  if (!isRecord(raw) || !isRecord(raw.isolation)) return null;
  const iso = raw.isolation;
  const blocked = count(iso.blocked);
  const total = count(iso.total);
  if (blocked === null || total === null || !Array.isArray(iso.attempts)) return null;
  const attempts = iso.attempts.flatMap((item): Attempt[] => {
    if (!isRecord(item) || !Array.isArray(item.results)) return [];
    const label = stringOrNull(item.label);
    if (label === null) return [];
    const results = item.results.flatMap((r) => {
      if (!isRecord(r)) return [];
      const direction = stringOrNull(r.direction);
      return direction === null ? [] : [{ direction, result: result(r.result) }];
    });
    return results.length === item.results.length ? [{ label, results }] : [];
  });
  return { result: result(iso.result), blocked, total, checkedAt: stringOrNull(iso.checked_at), attempts };
}

function cell(r: Result | undefined): string {
  return r === "pass" ? "✓ Blocked" : r === "fail" ? "✗ Got through" : "Couldn't run";
}

// Copy doc: Blocked green, Got through red, Couldn't run grey. The mark and
// word stay, so colour is never the only signal.
function cellColour(r: Result | undefined): string {
  return r === "pass" ? "success.main" : r === "fail" ? "error.main" : "text.secondary";
}

function heading(isolation: Isolation): { text: string; colour?: string; unconfirmed?: boolean } {
  const cells = isolation.attempts.flatMap((a) => a.results.map((r) => r.result));
  const v = isolationVerdict(cells, isolation.total);
  if (v.kind === "none") return { text: "The latest result is unknown" };
  if (v.kind === "fail") return { text: `✗ ${v.through} of ${v.attempts} attempts got through`, colour: "error" };
  if (v.kind === "pass") return { text: `✓ All ${v.attempts} attempts were blocked` };
  return {
    text: `! Not confirmed: ${v.couldntRun} of ${v.attempts} attempts couldn't run`,
    colour: "warning.main",
    unconfirmed: true,
  };
}


const DIRECTION_WIDTH = 160;

/** Switch web → Hosted → Isolation (W4): the latest isolation check from the
 *  overview the shell holds, as Console's built tab shows it. Read-only. */
export default function IsolationTab() {
  const { overview: raw, overviewStale } = useHosted();
  useOverviewRefresh();
  const isolation = useMemo(() => parseIsolation(raw), [raw]);

  if (isolation === null) {
    return (
      <Typography role="alert" color="error" sx={{ py: 2 }}>
        {LOAD_ERROR}
      </Typography>
    );
  }
  const stale = overviewStale && (
    <Typography variant="body2" color="text.secondary">
      {STALE}
    </Typography>
  );
  if (isolation.checkedAt === null || isolation.attempts.length === 0) {
    return (
      <Stack spacing={1.5}>
        {stale}
        <Typography variant="body2" color="text.secondary">
          {NOT_RUN}
        </Typography>
      </Stack>
    );
  }

  // Every direction any attempt names, in first-seen order; each cell is
  // looked up by direction, so a row listing them in another order still lands
  // under the right heading (engineer-4).
  const directions = [...new Set(isolation.attempts.flatMap((a) => a.results.map((r) => r.direction)))];
  const head = heading(isolation);

  return (
    <Stack spacing={1.5}>
      {stale}
      <Paper variant="outlined" sx={{ p: 2 }} component="section" aria-label="Isolation check">
        <Typography variant="subtitle2" component="h2" color={head.colour}>
          {head.text}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {head.unconfirmed
            ? `${NOT_CONFIRMED_LINE} Checked ${shortTime(isolation.checkedAt)}.`
            : `Checked ${shortTime(isolation.checkedAt)}. ${HOW}`}
        </Typography>
        <Table size="small" aria-label="Attempts" sx={{ tableLayout: "fixed" }}>
          <TableHead>
            <TableRow>
              <TableCell>Attempt</TableCell>
              {directions.map((d) => (
                <TableCell key={d} sx={{ width: DIRECTION_WIDTH }}>
                  {d}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {isolation.attempts.map((a, i) => {
              const byDirection = new Map(a.results.map((r) => [r.direction, r.result]));
              return (
                <TableRow key={i} data-testid="attempt-row">
                  <TableCell>{a.label}</TableCell>
                  {directions.map((d) => (
                    <TableCell key={d} sx={{ color: cellColour(byDirection.get(d)) }}>
                      {cell(byDirection.get(d))}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Paper>
    </Stack>
  );
}
