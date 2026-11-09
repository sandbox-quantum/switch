// Your cloud (hosted agents v2): the person's own box, as Switch Console's
// "Your cloud" card shows it. Only rendered with hosted agents v2 on and a box
// to show; every name and message here is plain React text.

import CheckCircleOutline from "@mui/icons-material/CheckCircleOutline";
import RadioButtonUnchecked from "@mui/icons-material/RadioButtonUnchecked";
import { Alert, Box, Button, Paper, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { ApiError, errorText } from "../../../data/api";
import {
  type CloudMachine,
  ensureCloudMachine,
  startCloudMachine,
} from "../../../data/hostedCloud";
import { pluralize } from "../../../theme/hootFormat";
import { EMPTY, RESTING_EXPLANATION, type SetupLine, setupChecklist } from "./peopleWords";
import StateFade from "./StateFade";
import CapacityList from "./CapacityList";
import { machineProblem, startBlocked, yourCloudView } from "./yourCloud";

/** Read by screen readers, not shown (as MUI's `visuallyHidden`, which is not a direct dependency here). */
const visuallyHidden = {
  border: 0,
  clip: "rect(0 0 0 0)",
  height: "1px",
  margin: "-1px",
  overflow: "hidden",
  padding: 0,
  position: "absolute",
  whiteSpace: "nowrap",
  width: "1px",
} as const;

const localTime = (at: Date) => at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export default function YourCloudPanel({
  machine,
  onChanged,
  loginSet = null,
  onGiveLogin,
  onAddAgent,
}: {
  machine: CloudMachine;
  /** Read the box again after Start. */
  onChanged: () => void;
  /** Whether the box has confirmed an AI login; null until known, which keeps the checklist hidden. */
  loginSet?: boolean | null;
  /** The checklist's Give login: takes the person to the AI logins. */
  onGiveLogin?: () => void;
  /** The checklist's Add agent: opens Add agent on Switch cloud. Absent when it can't be offered. */
  onAddAgent?: () => void;
}) {
  const cloud = yourCloudView(machine, localTime);
  const checklist = loginSet === null ? null : setupChecklist(machine, loginSet);
  // While the checklist shows the box's own state ("Starting… · Usually ready in
  // about two minutes."), the panel doesn't say it a second time.
  const repeatsChecklist =
    cloud.resting &&
    (checklist?.some(
      (line) => line.step === "cloud" && !line.done && line.text === cloud.heading && line.note === cloud.line,
    ) ??
      false);
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
        {machine.agents.length === 0 ? EMPTY.noAgents : pluralize(machine.agents.length, "agent")}
      </Typography>

      {checklist && (
        <SetupChecklist
          lines={checklist}
          pending={pending}
          onAction={(line) => {
            if (line.step === "cloud" && cloud.resting && cloud.start) void startBox(cloud.start);
            else if (line.step === "login") onGiveLogin?.();
            else if (line.step === "agent") onAddAgent?.();
          }}
          canAddAgent={onAddAgent !== undefined}
        />
      )}

      {/* One fade for the whole state block, so a change between resting and up fades too. */}
      <StateFade state={cloud.heading} component="div">
        {cloud.resting ? (
          <Box sx={{ mt: 1 }}>
            {!repeatsChecklist && (
              <Typography variant="body2">
                <Box component="span" sx={{ fontWeight: 600 }}>
                  {cloud.heading}
                </Box>
                {" · "}
                <Box component="span" sx={{ color: "text.secondary" }}>
                  {cloud.line}
                </Box>
              </Typography>
            )}
            {cloud.heading === "Resting" && machine.agents.length > 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 520 }}>
                {RESTING_EXPLANATION}
              </Typography>
            )}
            {/* The checklist's Start takes this button's place while it shows. */}
            {cloud.start && !blocked && !checklist?.some((line) => line.step === "cloud" && line.action) && (
              <Button
                variant="outlined"
                size="small"
                sx={{ mt: 1 }}
                disabled={pending}
                onClick={() => void startBox(cloud.start!)}
              >
                {pending
                  ? cloud.startLabel === "Wake"
                    ? "Waking…"
                    : "Starting…"
                  : (cloud.startLabel ?? "Start")}
              </Button>
            )}
          </Box>
        ) : (
          <Stack spacing={0.5} sx={{ mt: 1, maxWidth: 360 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {cloud.heading}
            </Typography>
            <CapacityList machine={machine} />
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
      </StateFade>

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

/** "Am I set up?": one line per step, ticked or with its button. It folds away once all three are ticked. */
function SetupChecklist({
  lines,
  pending,
  onAction,
  canAddAgent,
}: {
  lines: SetupLine[];
  pending: boolean;
  onAction: (line: SetupLine) => void;
  canAddAgent: boolean;
}) {
  return (
    <Box component="ul" aria-label="Setting up your cloud" sx={{ listStyle: "none", p: 0, m: 0, mt: 1.5 }}>
      {lines.map((line) => {
        const action = line.step === "agent" && !canAddAgent ? undefined : line.action;
        return (
          <Stack
            key={line.step}
            component="li"
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ py: 0.25, minHeight: 32 }}
            data-testid={`setup-${line.step}`}
          >
            {line.done ? (
              <CheckCircleOutline fontSize="small" color="success" aria-hidden />
            ) : (
              <RadioButtonUnchecked fontSize="small" color="action" aria-hidden />
            )}
            <Typography variant="body2" sx={{ flexGrow: 1 }}>
              <Box component="span" sx={{ fontWeight: line.done ? 400 : 500 }}>
                {line.text}
              </Box>
              {/* The tick is only a picture: say it in words for screen readers. */}
              {line.done && <Box component="span" sx={visuallyHidden}>, done</Box>}
              {line.note && (
                <Box component="span" sx={{ color: "text.secondary" }}>
                  {` · ${line.note}`}
                </Box>
              )}
            </Typography>
            {action && (
              <Button
                size="small"
                variant="outlined"
                disabled={line.step === "cloud" && pending}
                onClick={() => onAction(line)}
              >
                {line.step === "cloud" && pending ? "Starting…" : action}
              </Button>
            )}
          </Stack>
        );
      })}
    </Box>
  );
}
