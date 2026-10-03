import {
  Alert,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { type AgentDetail, updateAgentCanManageAgents } from "../../data/api";
import { fetchManagementAvailable } from "../../data/management";

/**
 * The agent's "can manage agents" capability: with it on, the agent may list
 * its owner's machines and managed agents and create managed agents on those
 * machines, acting for the owner. Shown only where agent management runs,
 * since the capability does nothing elsewhere, and changeable only by the
 * agent's owner.
 */
export default function AgentManagementSection({
  agent,
  canEdit,
  onUpdated,
}: {
  agent: AgentDetail;
  canEdit: boolean;
  onUpdated: () => void;
}) {
  const [available, setAvailable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchManagementAvailable()
      .then((value) => {
        if (!cancelled) setAvailable(value);
      })
      .catch((err: unknown) => {
        console.error("Could not tell whether agent management is enabled:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!available) return null;

  const toggle = async (enabled: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await updateAgentCanManageAgents(agent.id, enabled);
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
        <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
          Agent management
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        <FormControlLabel
          control={
            <Switch
              checked={agent.can_manage_agents}
              disabled={!canEdit || saving}
              onChange={(e) => void toggle(e.target.checked)}
            />
          }
          label="Can manage agents"
        />
        <Typography variant="body2" color="text.secondary">
          Lets this agent see your machines and managed agents, and create new agents that run on
          your machines and belong to you. Agents it creates do not get this permission.
          {!canEdit && " Only the agent's owner can change this."}
        </Typography>
      </Stack>
    </>
  );
}
