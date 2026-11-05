// Your cloud (hosted agents v2): the person's own box, as Switch Console's
// "Your cloud" card shows it. Only rendered with hosted agents v2 on and a box
// to show; every name and message here is plain React text.

import { Alert, Box, Button, LinearProgress, Paper, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { ApiError, errorText } from "../../../data/api";
import {
  type CloudMachine,
  ensureCloudMachine,
  startCloudMachine,
} from "../../../data/hostedCloud";
import { pluralize } from "../../../theme/hootFormat";
import { machineProblem, startBlocked, yourCloudView } from "./yourCloud";

const localTime = (at: Date) => at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export default function YourCloudPanel({
  machine,
  onChanged,
}: {
  machine: CloudMachine;
  /** Read the box again after Start. */
  onChanged: () => void;
}) {
  const cloud = yourCloudView(machine, localTime);
  const blocked = startBlocked(machine);
  const problem = machineProblem(machine);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => setActionError(null), [machine.revision, machine.state]);

  // A put-away (retained) or resting box is woken by asking Switch for it
  // (ensure); a box its owner stopped is started by lifecycle start, since
  // ensure leaves an owner's stop as it is.
  const startBox = async (how: "ensure" | "lifecycle") => {
    setPending(true);
    setActionError(null);
    try {
      if (how === "lifecycle") await startCloudMachine(machine);
      else await ensureCloudMachine();
    } catch (error) {
      setActionError(
        errorText(
          error instanceof ApiError ? error.detail : null,
          "Switch could not start your cloud.",
        ),
      );
    } finally {
      setPending(false);
      onChanged();
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }} aria-label="Your cloud" component="section">
      <Typography variant="subtitle1" component="h2">
        Your cloud
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {pluralize(machine.agents.length, "agent")}
      </Typography>

      {cloud.resting ? (
        <Box sx={{ mt: 1 }}>
          <Typography variant="body2">
            <Box component="span" sx={{ fontWeight: 600 }}>
              {cloud.heading}
            </Box>
            {" · "}
            <Box component="span" sx={{ color: "text.secondary" }}>
              {cloud.line}
            </Box>
          </Typography>
          {cloud.start && !blocked && (
            <Button
              variant="outlined"
              size="small"
              sx={{ mt: 1 }}
              disabled={pending}
              onClick={() => void startBox(cloud.start!)}
            >
              {pending ? "Starting…" : "Start"}
            </Button>
          )}
        </Box>
      ) : (
        <Stack spacing={0.5} sx={{ mt: 1, maxWidth: 360 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {cloud.heading}
          </Typography>
          {cloud.room && (
            <>
              <LinearProgress
                variant="determinate"
                value={cloud.room.usedPercent}
                aria-label="Room to work"
              />
              <Typography variant="body2" color="text.secondary">
                Room to work: {cloud.room.label}
              </Typography>
            </>
          )}
          {cloud.awake && (
            <Typography variant="body2" color="text.secondary">
              {cloud.awake.label}
            </Typography>
          )}
          {cloud.aiCalls && (
            <Typography
              variant="body2"
              color={cloud.aiCalls.capped ? "warning.main" : "text.secondary"}
            >
              {cloud.aiCalls.label}
            </Typography>
          )}
        </Stack>
      )}

      {problem && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {problem}
        </Alert>
      )}
      {actionError && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {actionError}
        </Alert>
      )}
    </Paper>
  );
}
