import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
} from "@mui/material";
import { useCallback, useEffect, useState } from "react";
import {
  type Budget,
  type UsageMetric,
  PER_MODEL_METRICS,
  USAGE_METRICS,
  createBudget,
  updateBudget,
} from "../../data/api";
import { useAgents } from "../../data/hooks";
import { metricLabel } from "./usageFormat";

const WHOLE_WORKSPACE = "";

interface Props {
  tenantId: string;
  // The budget being edited, or null to add one.
  budget: Budget | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export default function BudgetDialog({ tenantId, budget, open, onClose, onSaved }: Props) {
  const { data: agents } = useAgents();
  const [agentId, setAgentId] = useState(WHOLE_WORKSPACE);
  const [metric, setMetric] = useState<UsageMetric>("output_tokens");
  const [model, setModel] = useState("");
  const [limit, setLimit] = useState("");
  const [periodHours, setPeriodHours] = useState("24");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAgentId(budget?.agent_id ?? WHOLE_WORKSPACE);
    setMetric(budget?.metric ?? "output_tokens");
    setModel(budget?.model ?? "");
    setLimit(budget ? String(budget.amount_limit) : "");
    setPeriodHours(budget ? String(budget.period_hours) : "24");
    setError(null);
  }, [open, budget]);

  const perModel = PER_MODEL_METRICS.includes(metric);
  const limitValue = Number(limit);
  const periodValue = Number(periodHours);
  const valid =
    Number.isInteger(limitValue) &&
    limitValue > 0 &&
    Number.isInteger(periodValue) &&
    periodValue > 0;

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (budget) {
        await updateBudget(tenantId, budget.id, {
          amount_limit: limitValue,
          period_hours: periodValue,
        });
      } else {
        await createBudget(tenantId, {
          agent_id: agentId === WHOLE_WORKSPACE ? null : agentId,
          metric,
          model: perModel ? model.trim() : "",
          amount_limit: limitValue,
          period_hours: periodValue,
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the budget.");
    } finally {
      setSubmitting(false);
    }
  }, [budget, tenantId, agentId, metric, perModel, model, limitValue, periodValue, onSaved, onClose]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{budget ? "Edit budget" : "Add budget"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          {budget && (
            <Alert severity="info">
              What a budget covers is fixed. To cover something else, add another budget.
            </Alert>
          )}
          <TextField
            select
            label="Applies to"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            disabled={budget !== null}
            helperText="A workspace budget caps what all agents spend together."
            fullWidth
          >
            <MenuItem value={WHOLE_WORKSPACE}>Every agent in the workspace</MenuItem>
            {(agents ?? []).map((agent) => (
              <MenuItem key={agent.id} value={agent.id}>
                {agent.name}
              </MenuItem>
            ))}
            {budget?.agent_id && !(agents ?? []).some((a) => a.id === budget.agent_id) && (
              <MenuItem value={budget.agent_id}>{budget.agent_name ?? budget.agent_id}</MenuItem>
            )}
          </TextField>
          <TextField
            select
            label="Metric"
            value={metric}
            onChange={(e) => setMetric(e.target.value as UsageMetric)}
            disabled={budget !== null}
            fullWidth
          >
            {USAGE_METRICS.map((m) => (
              <MenuItem key={m} value={m}>
                {metricLabel(m)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Model"
            value={perModel ? model : ""}
            onChange={(e) => setModel(e.target.value)}
            disabled={budget !== null || !perModel}
            placeholder="Every model"
            helperText={
              perModel
                ? "Leave empty to cover every model."
                : `${metricLabel(metric)} are not counted per model.`
            }
            fullWidth
          />
          <Stack direction="row" spacing={2}>
            <TextField
              label="Limit"
              type="number"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              required
              fullWidth
              slotProps={{ htmlInput: { min: 1, step: 1 } }}
            />
            <TextField
              label="Period (hours)"
              type="number"
              value={periodHours}
              onChange={(e) => setPeriodHours(e.target.value)}
              required
              fullWidth
              helperText="24 is a day, 168 a week."
              slotProps={{ htmlInput: { min: 1, step: 1 } }}
            />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={submitting || !valid}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
        >
          {budget ? "Save" : "Add"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
