import { Box, Chip, Paper, Stack, Typography } from "@mui/material";
import { useMemo } from "react";
import { useHosted } from "../HostedContext";
import AlertTitle from "../w5shared/AlertTitle";
import { isRecord, shortTime, stringOrNull } from "../w5shared/operatorFetch";

export const NOW_HEADING = "Now";
export const NOW_EMPTY = "No alerts right now.";
export const CLEARED_HEADING = "Cleared in the last 24 hours";
export const CLEARED_EMPTY = "Nothing cleared in the last 24 hours.";
export const LOAD_ERROR = "Couldn't load alerts. Reload the page to try again.";
export const STALE = "Couldn't refresh just now. These figures may be out of date.";

export interface HostedAlert {
  id: string;
  severity: "critical" | "warning";
  title: string;
  detail: string;
  raisedAt: string | null;
  clearedAt: string | null;
}

/** The alerts in the shell's overview (Core's `/shared-cloud/overview`,
 *  V5's `overview_alerts`): every open one, and every one cleared in the last
 *  24 hours. The overview is typed as unknown, so only alerts in the shape
 *  Core sends are kept. A row with anything else in
 *  it is dropped, never shown half-read. A missing `alerts` list is an error,
 *  not an empty one, so a broken answer never reads as "No alerts". */
export function parseAlerts(raw: unknown): HostedAlert[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.alerts)) return null;
  const alerts: HostedAlert[] = [];
  for (const item of raw.alerts) {
    if (!isRecord(item)) continue;
    const id = stringOrNull(item.id);
    const title = stringOrNull(item.title);
    const severity = item.severity;
    if (id === null || title === null) continue;
    if (severity !== "critical" && severity !== "warning") continue;
    alerts.push({
      id,
      severity,
      title,
      detail: stringOrNull(item.detail) ?? "",
      raisedAt: stringOrNull(item.raised_at),
      clearedAt: stringOrNull(item.cleared_at),
    });
  }
  return alerts;
}

function SeverityBadge({ severity }: { severity: HostedAlert["severity"] }) {
  return (
    <Chip
      size="small"
      label={severity === "critical" ? "Critical" : "Warning"}
      color={severity === "critical" ? "error" : "warning"}
      variant="outlined"
    />
  );
}

/** Switch web → Hosted → Alerts (W5, p13). Read-only. It reads the overview
 *  the shell already holds, so it makes no request of its own: the shell
 *  handles 401 and 403, and `refresh()` updates it. */
export default function AlertsTab() {
  const { overview, overviewStale } = useHosted();
  const alerts = useMemo(() => parseAlerts(overview), [overview]);

  if (alerts === null) {
    return (
      <Typography role="alert" color="error" sx={{ py: 2 }}>
        {LOAD_ERROR}
      </Typography>
    );
  }

  const open = alerts.filter((a) => a.clearedAt === null);
  const cleared = alerts.filter((a) => a.clearedAt !== null);

  return (
    <Stack spacing={1.5} sx={{ py: 1 }}>
      {overviewStale && (
        <Typography variant="body2" color="text.secondary" role="status">
          {STALE}
        </Typography>
      )}
      <Typography variant="h6" component="h2">
        {NOW_HEADING}
      </Typography>
      {open.length === 0 ? (
        <Typography color="text.secondary">{NOW_EMPTY}</Typography>
      ) : (
        <Stack
          spacing={1}
          component="ul"
          aria-label={NOW_HEADING}
          sx={{ listStyle: "none", p: 0, m: 0 }}
        >
          {open.map((alert) => (
            <Paper component="li" key={alert.id} variant="outlined" sx={{ p: 2 }}>
              <Stack direction="row" spacing={1.5} alignItems="flex-start">
                <SeverityBadge severity={alert.severity} />
                <Box>
                  <Typography fontWeight={600}>
                    <AlertTitle title={alert.title} />
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Raised {shortTime(alert.raisedAt)}
                    {alert.detail ? ` · ${alert.detail}` : ""}
                  </Typography>
                </Box>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}
      <Typography variant="h6" component="h2" sx={{ pt: 1 }}>
        {CLEARED_HEADING}
      </Typography>
      {cleared.length === 0 ? (
        <Typography color="text.secondary">{CLEARED_EMPTY}</Typography>
      ) : (
        <Stack
          spacing={1}
          component="ul"
          aria-label={CLEARED_HEADING}
          sx={{ listStyle: "none", p: 0, m: 0 }}
        >
          {cleared.map((alert) => (
            <Paper component="li" key={alert.id} variant="outlined" sx={{ p: 2 }}>
              <Typography variant="body2">
                <AlertTitle title={alert.title} /> · raised {shortTime(alert.raisedAt)} · cleared{" "}
                {shortTime(alert.clearedAt)}
              </Typography>
            </Paper>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
