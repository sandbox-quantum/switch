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
  DAILY_CAP_HELP,
  MAX_BUDGET_AMOUNT,
  MAX_BUDGET_PERIOD_HOURS,
  PER_MODEL_METRICS,
  budgetMetrics,
  createBudget,
  updateBudget,
} from "../../data/api";
import { useAgents, useFeatureFlags } from "../../data/hooks";
import { budgetMetricLabel, dailyCapProblem, formatAmount, metricLabel, parseBound } from "./usageFormat";

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
  const { data: flags } = useFeatureFlags();
  const metrics = budgetMetrics(flags?.hosted_awake_budgets === true);
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

  // The daily AI cap (L1b): every agent, per day, within the gateway's range.
  const dailyCap = metric === "hosted_ai_calls";
  const perModel = PER_MODEL_METRICS.includes(metric);
  const capProblem = dailyCap ? dailyCapProblem(limit) : null;
  const limitValue = dailyCap
    ? capProblem === null
      ? Number(limit.trim())
      : null
    : parseBound(limit, MAX_BUDGET_AMOUNT);
  const periodValue = dailyCap ? 24 : parseBound(periodHours, MAX_BUDGET_PERIOD_HOURS);
  const limitInvalid = limit.trim() !== "" && limitValue === null;
  const periodInvalid = !dailyCap && periodHours.trim() !== "" && periodValue === null;

  const chooseMetric = (next: UsageMetric) => {
    setMetric(next);
    if (next === "hosted_ai_calls") {
      setAgentId(WHOLE_WORKSPACE);
      setPeriodHours("24");
    }
  };

  const handleSubmit = useCallback(async () => {
    if (limitValue === null || periodValue === null) return;
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
          agent_id: dailyCap || agentId === WHOLE_WORKSPACE ? null : agentId,
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
  }, [budget, tenantId, agentId, dailyCap, metric, perModel, model, limitValue, periodValue, onSaved, onClose]);

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
            disabled={budget !== null || dailyCap}
            // The whole-workspace choice is the empty value, which a select
            // otherwise shows as blank (designer's fix list, item 6).
            slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
            helperText={
              dailyCap
                ? "The daily AI cap covers every person's agents."
                : "A workspace budget caps what all agents spend together."
            }
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
            onChange={(e) => chooseMetric(e.target.value as UsageMetric)}
            disabled={budget !== null}
            helperText={dailyCap ? DAILY_CAP_HELP : undefined}
            fullWidth
          >
            {(budget && !metrics.includes(budget.metric) ? [...metrics, budget.metric] : metrics).map((m) => (
              <MenuItem key={m} value={m}>
                {budgetMetricLabel(m)}
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
              error={limitInvalid}
              helperText={
                limitInvalid
                  ? (capProblem ?? `A whole number from 1 to ${formatAmount(MAX_BUDGET_AMOUNT)}.`)
                  : undefined
              }
              slotProps={{ htmlInput: { min: 1, max: MAX_BUDGET_AMOUNT, step: 1 } }}
            />
            <TextField
              label="Period (hours)"
              type="number"
              value={periodHours}
              onChange={(e) => setPeriodHours(e.target.value)}
              required
              fullWidth
              disabled={dailyCap}
              error={periodInvalid}
              helperText={
                dailyCap
                  ? "Fixed at one day for the daily AI cap."
                  : periodInvalid
                    ? `A whole number of hours from 1 to ${formatAmount(MAX_BUDGET_PERIOD_HOURS)}.`
                    : "24 is a day, 168 a week."
              }
              slotProps={{ htmlInput: { min: 1, max: MAX_BUDGET_PERIOD_HOURS, step: 1 } }}
            />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={submitting || limitValue === null || periodValue === null}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
        >
          {budget ? "Save" : "Add"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
