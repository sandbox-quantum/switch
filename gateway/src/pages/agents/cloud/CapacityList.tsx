// Your cloud's capacity as three labelled rows, each with a bar: agents
// awake, memory and the workspace disk. The same words and steps as
// Console's `HostedCapacityRows`. Every figure is in the text as well as the
// bar, so nothing depends on colour.

import { Box, LinearProgress, Stack, Typography } from "@mui/material";
import type { CloudMachine } from "../../../data/hostedCloud";
import { type CapacityLine, DISK_NOT_AVAILABLE, capacityRows } from "./capacity";

const BAR_COLOUR = { ok: "primary", nearly_full: "warning", full: "error" } as const;
const ADVICE_COLOUR = { nearly_full: "warning.main", full: "error.main" } as const;

function CapacityRow({ line, name }: { line: CapacityLine; name: string }) {
  return (
    <Box data-capacity={name} data-step={line.step}>
      <Typography variant="body2">{line.label}</Typography>
      <LinearProgress
        variant="determinate"
        value={line.usedPercent}
        color={BAR_COLOUR[line.step]}
        aria-label={line.label}
        aria-valuetext={line.label}
        sx={{ mt: 0.5 }}
      />
      {line.advice && line.step !== "ok" && (
        <Typography variant="body2" sx={{ mt: 0.5, color: ADVICE_COLOUR[line.step] }}>
          {line.advice}
        </Typography>
      )}
    </Box>
  );
}

export default function CapacityList({
  machine,
}: {
  machine: Pick<CloudMachine, "awake" | "room" | "disk">;
}) {
  const rows = capacityRows(machine);
  return (
    <Stack spacing={1}>
      {rows.awake && <CapacityRow line={rows.awake} name="awake" />}
      {rows.memory && <CapacityRow line={rows.memory} name="memory" />}
      {rows.disk ? (
        <CapacityRow line={rows.disk} name="disk" />
      ) : (
        <Typography variant="body2" color="text.secondary" data-capacity="disk">
          {DISK_NOT_AVAILABLE}
        </Typography>
      )}
    </Stack>
  );
}
