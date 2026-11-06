// A machine's (a node's) detail page: its boxes and their agents by state,
// its memory, and its recent activity. Current figures only, from the
// overview the shell holds, plus the audit log for this machine. Disk and CPU
// aren't in the cluster report, so they aren't shown at all.

import {
  Alert,
  Box,
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
import { Link as RouterLink, useParams } from "react-router";
import { CapacityRow } from "../../agents/cloud/CapacityList";
import { shortId } from "../audit/auditWords";
import { useHosted } from "../HostedContext";
import { STALE } from "../overview/overview";
import { Activity, Donut, Fact, Section, ago } from "./DetailParts";
import { MACHINE_GONE, NOT_AVAILABLE, boxSlice, machineDetail } from "./detail";
import { readDetail } from "./readDetail";

export const STATE_WORDS: Record<string, string> = {
  running: "Awake",
  starting: "Starting",
  resting: "Resting",
  stopping: "Stopping",
  stopped: "Stopped",
  paused: "Paused",
  error: "Failed to start",
  retired: "Put away",
};

export default function MachineDetailPage() {
  const { machineId = "" } = useParams();
  const { overview, overviewStale } = useHosted();
  const data = useMemo(() => readDetail(overview), [overview]);
  const detail = data ? machineDetail(data, machineId) : null;
  const [picked, setPicked] = useState<string | null>(null);

  if (!data || !detail)
    return (
      <Stack spacing={2}>
        <Link component={RouterLink} to="/hosted/machines">
          All machines
        </Link>
        <Alert severity="info">{MACHINE_GONE}</Alert>
      </Stack>
    );

  const boxes = picked ? detail.boxes.filter((b) => boxSlice(b.state) === picked) : detail.boxes;
  const report = ago(data.reportAt);
  return (
    <Stack spacing={2}>
      <Link component={RouterLink} to="/hosted/machines">
        All machines
      </Link>
      <Typography variant="h6" component="h2">
        {detail.machine.name}
      </Typography>
      {(overviewStale || data.reportStale) && (
        <Alert severity="warning">{STALE}</Alert>
      )}
      <Stack direction="row" spacing={4} flexWrap="wrap" useFlexGap>
        <Fact label="Zone" value={detail.machine.zone} />
        <Fact label="Boxes" value={String(detail.boxes.length)} />
        <Fact label="Last report" value={report.text} title={report.title} />
      </Stack>

      <Section title="Memory">
        <Stack spacing={1} sx={{ maxWidth: 420 }}>
          {detail.memoryUsed ? (
            <CapacityRow line={detail.memoryUsed} name="memory-used" />
          ) : (
            <Typography variant="body2">Memory used: {NOT_AVAILABLE}</Typography>
          )}
          {detail.memoryBooked ? (
            <CapacityRow line={detail.memoryBooked} name="memory-booked" />
          ) : (
            <Typography variant="body2">Memory booked: {NOT_AVAILABLE}</Typography>
          )}
        </Stack>
      </Section>

      <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
        <Box sx={{ flex: 1 }}>
          <Section title="Boxes by state">
            <Donut
              title="Boxes by state"
              slices={detail.boxSlices}
              selected={picked}
              onSelect={setPicked}
            />
          </Section>
        </Box>
        <Box sx={{ flex: 1 }}>
          <Section title="Agents by state">
            <Donut title="Agents by state" slices={detail.agentSlices} />
          </Section>
        </Box>
      </Stack>

      <Section title={picked ? "Boxes (filtered)" : "Boxes"}>
        {boxes.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No boxes here.
          </Typography>
        ) : (
          <Box sx={{ overflowX: "auto" }}>
            <Table size="small" aria-label="Boxes on this machine">
              <TableHead>
                <TableRow>
                  <TableCell>Box</TableCell>
                  <TableCell>State</TableCell>
                  <TableCell>Restarts today</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {boxes.map((b) => (
                  <TableRow key={b.box}>
                    <TableCell>
                      <Link
                        component={RouterLink}
                        to={`/hosted/boxes/${encodeURIComponent(b.box)}`}
                        title={b.box}
                        sx={{ fontFamily: "monospace" }}
                      >
                        {shortId(b.box)}
                      </Link>
                    </TableCell>
                    <TableCell>{STATE_WORDS[b.state] ?? b.state}</TableCell>
                    <TableCell>{b.restartsToday ?? NOT_AVAILABLE}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
      </Section>

      <Section title="Recent activity">
        <Activity targetId={detail.machine.machine} />
      </Section>
    </Stack>
  );
}
