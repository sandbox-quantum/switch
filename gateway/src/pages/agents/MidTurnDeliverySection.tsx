import {
  Alert,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { type AgentDetail, updateAgentMidTurnDelivery } from "../../data/api";

/**
 * What a message sent while the agent is working does: steer into the running
 * turn (the default) or always queue behind it. Changeable by whoever may
 * manage the agent; it applies to the next message, with no restart.
 */
export default function MidTurnDeliverySection({
  agent,
  canEdit,
  onUpdated,
}: {
  agent: AgentDetail;
  canEdit: boolean;
  onUpdated: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (agent.mid_turn_delivery === undefined) return null;

  const toggle = async (steer: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await updateAgentMidTurnDelivery(agent.id, steer ? "steer" : "queue");
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Divider />
      <Stack spacing={1}>
        <Typography
          variant="overline"
          sx={{ color: "text.secondary", display: "block" }}
        >
          Messages sent while it works
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        <FormControlLabel
          control={
            <Switch
              checked={agent.mid_turn_delivery === "steer"}
              disabled={!canEdit || saving}
              onChange={(e) => void toggle(e.target.checked)}
            />
          }
          label="Steer into the running turn"
        />
        <Typography variant="body2" color="text.secondary">
          A message sent while the agent is working reaches the running
          turn instead of waiting for it to end, whoever sent it and from
          wherever. The agent reads it at its next step: Claude Code after the
          tool call or answer in progress. Agents whose CLI cannot steer always
          queue. Off: messages from rooms wait for the turn to end.
          {!canEdit &&
            " Only the agent's owner or a workspace admin can change this."}
        </Typography>
      </Stack>
    </>
  );
}
