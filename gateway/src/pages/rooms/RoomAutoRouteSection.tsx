import {
  Alert,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import {
  type RoomAutoRoute,
  type RoomDetail,
  type SetRoomAutoRouteInput,
  setRoomAutoRoute,
} from "../../data/api";
import { useAgents } from "../../data/hooks";

/**
 * The room's `!auto-route` setting as a toggle, and the triage agent that
 * gets undecided messages while the decision service is failing. Shows what
 * the server says: the toggle never flips before the server has answered,
 * and where auto-route cannot work here it says why, in the server's words.
 */
export default function RoomAutoRouteSection({
  room,
  autoRoute,
  canManage,
}: {
  room: RoomDetail;
  autoRoute: RoomAutoRoute;
  canManage: boolean;
}) {
  const { data: allAgents } = useAgents();
  const [state, setState] = useState(autoRoute);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setState(autoRoute), [autoRoute]);

  const triageChoices = useMemo(() => {
    const choices = (allAgents ?? [])
      .filter((a) => room.agent_ids.includes(a.id))
      .map((a) => ({ id: a.id, name: a.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // A triage agent that has since left the room is still the setting.
    const triage = state.fallback_agent;
    if (triage && !choices.some((c) => c.id === triage)) {
      const known = (allAgents ?? []).find((a) => a.id === triage);
      choices.push({ id: triage, name: state.fallback_agent_name ?? known?.name ?? triage });
    }
    return choices;
  }, [allAgents, room.agent_ids, state.fallback_agent, state.fallback_agent_name]);

  const save = async (input: SetRoomAutoRouteInput) => {
    setSaving(true);
    setError(null);
    try {
      setState(await setRoomAutoRoute(room.id, input));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update auto-route");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Auto-route
      </Typography>
      <Typography variant="caption" color="text.secondary">
        When on, a message that tags nobody goes to the one agent the
        workspace's decision service picks, or to nobody. Same setting as{" "}
        <code>!auto-route</code> in the room.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {!state.available && state.reason && <Alert severity="info">{state.reason}</Alert>}
      <FormControlLabel
        control={
          <Switch
            checked={state.on}
            onChange={(e) => save({ on: e.target.checked })}
            // Turning it off stays possible where it cannot work.
            disabled={!canManage || saving || (!state.available && !state.on)}
          />
        }
        label={state.on ? "On" : "Off"}
      />
      <TextField
        select
        size="small"
        label="Triage agent while auto-route is unavailable"
        value={state.fallback_agent ?? ""}
        onChange={(e) => save({ fallback_agent: e.target.value || null })}
        disabled={!canManage || saving}
        sx={{ width: 360 }}
        helperText={
          canManage
            ? "Gets the messages auto-route could not decide while the decision service is failing. Off by default."
            : "Only the room's owner or a workspace admin can change auto-route."
        }
      >
        <MenuItem value="">None</MenuItem>
        {triageChoices.map((choice) => (
          <MenuItem key={choice.id} value={choice.id}>
            {choice.name}
          </MenuItem>
        ))}
      </TextField>
    </Stack>
  );
}
