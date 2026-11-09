// Pieces the machine and box detail pages share: a donut with its counts in
// text beside it, a timeline of the audit events on one target, and a fact
// list. Labels and tooltips are plain strings, never HTML (security's
// condition for `@mui/x-charts`).

import {
  Box,
  ButtonBase,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { PieChart } from "@mui/x-charts/PieChart";
import { useEffect, useState } from "react";
import { absoluteTitle, formatRelative } from "../../../theme/hootFormat";
import { AUDIT_PATH, buildRows, parseEntries, type AuditRow } from "../audit/AuditTab";
import { useHosted } from "../HostedContext";
import { readOperatorRoute } from "../w5shared/operatorFetch";
import { NOT_AVAILABLE, type Slice } from "./detail";

/** How many of a target's events the timeline shows: the newest. */
export const ACTIVITY_LIMIT = 20;
export const ACTIVITY_EMPTY = "Nothing recorded yet.";
export const ACTIVITY_ERROR = "Couldn't load the activity. It will try again shortly.";

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Paper variant="outlined" component="section" aria-label={title} sx={{ p: 2 }}>
      <Typography variant="subtitle1" component="h2" sx={{ mb: 1 }}>
        {title}
      </Typography>
      {children}
    </Paper>
  );
}

/**
 * A donut of counts, with the same counts as a list beside it so nothing
 * depends on the chart or its colours. Clicking a slice, or its line in the
 * list, picks it (`onSelect`); clicking the picked one again clears it.
 */
export function Donut({
  title,
  slices,
  selected = null,
  onSelect,
}: {
  title: string;
  slices: Slice[];
  selected?: string | null;
  onSelect?: (key: string | null) => void;
}) {
  const total = slices.reduce((sum, s) => sum + s.count, 0);
  const pick = (key: string) => onSelect?.(selected === key ? null : key);
  const shown = slices.filter((s) => s.count > 0);
  return (
    <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems="center">
      {total > 0 ? (
        <PieChart
          width={160}
          height={160}
          hideLegend
          aria-label={title}
          series={[
            {
              innerRadius: 45,
              outerRadius: 75,
              data: shown.map((s) => ({ id: s.key, value: s.count, label: s.label })),
            },
          ]}
          onItemClick={(_event, item) => {
            const slice = shown[item.dataIndex];
            if (slice) pick(slice.key);
          }}
        />
      ) : null}
      <List dense aria-label={title} sx={{ minWidth: 200 }}>
        {slices.map((s) => (
          <ListItem key={s.key} disablePadding>
            <ButtonBase
              onClick={() => pick(s.key)}
              disabled={!onSelect}
              aria-pressed={onSelect ? selected === s.key : undefined}
              sx={{
                width: "100%",
                justifyContent: "flex-start",
                px: 1,
                borderRadius: 1,
                fontWeight: selected === s.key ? 600 : 400,
              }}
            >
              <ListItemText primary={`${s.label}: ${s.count}`} />
            </ButtonBase>
          </ListItem>
        ))}
        {total === 0 && (
          <ListItem>
            <ListItemText secondary="None right now." />
          </ListItem>
        )}
      </List>
    </Stack>
  );
}

/** A label and its value; "Not available" when the value is missing. */
export function Fact({ label, value, title }: { label: string; value: string | null; title?: string }) {
  return (
    <Box>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" title={value === null ? undefined : title}>
        {value ?? NOT_AVAILABLE}
      </Typography>
    </Box>
  );
}

/** A time as "4 min ago", with the full time on hover; null stays null. */
export function ago(iso: string | null): { text: string | null; title?: string } {
  return iso === null ? { text: null } : { text: formatRelative(iso), title: absoluteTitle(iso) };
}

export function activityPath(targetId: string): string {
  const params = new URLSearchParams({ target_id: targetId, limit: String(ACTIVITY_LIMIT) });
  return `${AUDIT_PATH}?${params.toString()}`;
}

/**
 * The newest events Core's audit log holds for one target (a box's or a
 * machine's keyed id), worded as the Audit log tab words them. Read again
 * whenever the shell refreshes.
 */
export function Activity({ targetId }: { targetId: string }) {
  const { operator, refreshKey } = useHosted();
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    readOperatorRoute(activityPath(targetId), parseEntries, controller.signal)
      .then((read) => {
        if (read.kind === "ok") {
          setRows(buildRows(read.body, operator.id));
          setFailed(false);
        } else setFailed(true);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [targetId, operator.id, refreshKey]);

  if (failed && rows === null)
    return (
      <Typography variant="body2" color="text.secondary">
        {ACTIVITY_ERROR}
      </Typography>
    );
  if (rows === null) return null;
  if (rows.length === 0)
    return (
      <Typography variant="body2" color="text.secondary">
        {ACTIVITY_EMPTY}
      </Typography>
    );
  return (
    <List dense aria-label="Recent activity">
      {rows.map((row) => (
        <ListItem key={row.id} disableGutters>
          <ListItemText
            primary={`${row.action.text} · ${row.result.text}`}
            secondary={`${row.when} · ${row.who}`}
          />
        </ListItem>
      ))}
    </List>
  );
}
