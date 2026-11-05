import { Alert, FormControlLabel, Stack, Switch, Typography } from "@mui/material";
import { useState } from "react";
import { type AgentDetail, updateAgentMidTurnDelivery } from "../../data/api";

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
  const save = async (enabled: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await updateAgentMidTurnDelivery(agent.id, enabled ? "steer" : "queue");
      onUpdated();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  if (agent.mid_turn_delivery === undefined) return null;
  return (
    <Stack spacing={1}>
      <Typography variant="overline">Messages during a turn</Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <FormControlLabel
        label="Steer eligible messages into the running turn"
        control={
          <Switch
            checked={agent.mid_turn_delivery !== "queue"}
            disabled={!canEdit || saving}
            onChange={(event) => void save(event.target.checked)}
          />
        }
      />
      <Typography variant="body2" color="text.secondary">
        Same-thread corrections from the turn starter or agent owner can steer supported providers.
        Other messages queue. Turn this off to always queue. Changes apply to new messages.
      </Typography>
    </Stack>
  );
}
