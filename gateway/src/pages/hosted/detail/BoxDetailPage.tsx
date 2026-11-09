// A box's detail page: its state, its agents by state, its capacity (awake,
// memory and the workspace disk) and its recent activity. Current figures
// only, from the overview the shell holds, plus the audit log for this box.
// Ids are keyed ids, shown short; no names, files or conversations.

import { Alert, Box, Link, Stack, Typography } from "@mui/material";
import { useMemo } from "react";
import { Link as RouterLink, useParams } from "react-router";
import CapacityList from "../../agents/cloud/CapacityList";
import { useHosted } from "../HostedContext";
import { STALE } from "../overview/overview";
import { Activity, Donut, Fact, Section, ago } from "./DetailParts";
import { BOX_GONE, boxDetail, boxMemory, runningSince } from "./detail";
import { STATE_WORDS } from "./MachineDetailPage";
import { readDetail } from "./readDetail";
import IdCell from "../w5shared/IdCell";

export default function BoxDetailPage() {
  const { boxId = "" } = useParams();
  const { overview, overviewStale } = useHosted();
  const data = useMemo(() => readDetail(overview), [overview]);
  const detail = data ? boxDetail(data, boxId) : null;

  if (!detail)
    return (
      <Stack spacing={2}>
        <Link component={RouterLink} to="/hosted/boxes">
          All boxes
        </Link>
        <Alert severity="info">{BOX_GONE}</Alert>
      </Stack>
    );

  const { box, machine } = detail;
  const active = ago(box.activeAt);
  const report = ago(box.heartbeatAt);
  const since = ago(runningSince(box));
  return (
    <Stack spacing={2}>
      <Link component={RouterLink} to="/hosted/boxes">
        All boxes
      </Link>
      <Typography variant="h6" component="h2">
        Box <IdCell id={box.box} label="box id" />
      </Typography>
      {overviewStale && <Alert severity="warning">{STALE}</Alert>}

      <Stack direction="row" spacing={4} flexWrap="wrap" useFlexGap>
        <Fact label="State" value={STATE_WORDS[box.state] ?? box.state} />
        <Box>
          <Typography variant="body2" color="text.secondary">
            Machine
          </Typography>
          {machine ? (
            <Link
              component={RouterLink}
              to={`/hosted/machines/${encodeURIComponent(machine.machine)}`}
              variant="body2"
            >
              {machine.name}
            </Link>
          ) : (
            <Typography variant="body2">{box.node ?? "Not available"}</Typography>
          )}
        </Box>
        <Fact label="Restarts today" value={box.restartsToday === null ? null : String(box.restartsToday)} />
        <Box>
          <Typography variant="body2" color="text.secondary">
            Person
          </Typography>
          <Typography variant="body2">
            <IdCell id={box.user} label="person id" />
          </Typography>
        </Box>
        <Box>
          <Typography variant="body2" color="text.secondary">
            Workspaces
          </Typography>
          <Typography variant="body2">
            {box.workspaces.length === 0
              ? "None"
              : box.workspaces.map((w, i) => (
                  <span key={w}>
                    {i > 0 && ", "}
                    <IdCell id={w} label="workspace id" />
                  </span>
                ))}
          </Typography>
        </Box>
      </Stack>

      <Stack direction="row" spacing={4} flexWrap="wrap" useFlexGap>
        <Fact label="Last active" value={active.text} title={active.title} />
        <Fact label="Last report" value={report.text} title={report.title} />
        {box.state === "running" && (
          <Fact label="Running since" value={since.text} title={since.title} />
        )}
      </Stack>

      <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
        <Box sx={{ flex: 1 }}>
          <Section title="Capacity">
            <Box sx={{ maxWidth: 420 }}>
              <CapacityList
                machine={{ awake: box.awake, room: boxMemory(box), disk: box.disk ?? null }}
              />
            </Box>
          </Section>
        </Box>
        <Box sx={{ flex: 1 }}>
          <Section title="Agents by state">
            <Donut title="Agents by state" slices={detail.agentSlices} />
          </Section>
        </Box>
      </Stack>

      <Section title="Recent activity">
        <Activity targetId={box.box} />
      </Section>
    </Stack>
  );
}
