import AddCircleOutline from "@mui/icons-material/AddCircleOutline";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import EditOutlined from "@mui/icons-material/EditOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  LinearProgress,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useCallback, useMemo, useState } from "react";
import DataTable from "../../components/DataTable";
import {
  type Budget,
  type CurrentTenant,
  type HostedUsagePerson,
  type UsageTotal,
  deleteBudget,
} from "../../data/api";
import {
  useBudgets,
  useCurrentTenant,
  useHostedUsage,
  useHostedV2,
  useUsage,
} from "../../data/hooks";
import { formatDateTime } from "../../theme/hootFormat";
import BudgetDialog from "./BudgetDialog";
import {
  budgetMetricLabel,
  capLine,
  formatAmount,
  formatPeriod,
  hoursLabel,
  metricLabel,
} from "./usageFormat";

const WINDOWS = [
  { label: "Last 24 hours", hours: 24 },
  { label: "Last 7 days", hours: 24 * 7 },
  { label: "Last 30 days", hours: 24 * 30 },
];

type UsageRow = UsageTotal & { id: string };

export default function UsagePage() {
  const { data: tenant, loading, error } = useCurrentTenant();

  if (loading) return <CircularProgress />;
  if (error || !tenant) {
    return <Alert severity="error">Could not load the current workspace.</Alert>;
  }
  if (!tenant.administers) {
    return (
      <Alert severity="info">
        Only owners and admins of {tenant.name} can see its usage and budgets.
      </Alert>
    );
  }
  return <WorkspaceUsage tenant={tenant} />;
}

function WorkspaceUsage({ tenant }: { tenant: CurrentTenant }) {
  // Hosted agents' rows and the daily AI cap are v2's: shown only when Core says it's on.
  const hostedV2 = useHostedV2() === true;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0, gap: 3 }}>
      <Typography variant="h5">Usage · {tenant.name}</Typography>
      <BudgetsSection tenantId={tenant.id} hostedV2={hostedV2} />
      {hostedV2 && <HostedUsageSection tenantId={tenant.id} />}
      <UsageSection tenantId={tenant.id} />
    </Box>
  );
}

function BudgetsSection({ tenantId, hostedV2 }: { tenantId: string; hostedV2: boolean }) {
  const { data: allBudgets, loading, error, refetch } = useBudgets(tenantId);
  const budgets = useMemo(
    // Daily-AI-cap and awake-time budgets are hosted agents v2's: with it off,
    // ones made while it was on aren't shown.
    () =>
      allBudgets?.filter(
        (b) => hostedV2 || (b.metric !== "hosted_ai_calls" && b.metric !== "awake_minutes"),
      ) ?? null,
    [allBudgets, hostedV2],
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Budget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Budget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const openEditor = useCallback((budget: Budget | null) => {
    setEditing(budget);
    setDialogOpen(true);
  }, []);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteBudget(tenantId, deleteTarget.id);
      setDeleteTarget(null);
      refetch();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to remove the budget.");
    } finally {
      setDeleting(false);
    }
  }, [tenantId, deleteTarget, refetch]);

  const columns = useMemo<GridColDef<Budget>[]>(
    () => [
      {
        field: "agent_name",
        headerName: "Applies to",
        flex: 1,
        minWidth: 180,
        valueGetter: (_value, row) =>
          row.agent_id === null ? "Every agent" : (row.agent_name ?? row.agent_id),
      },
      {
        field: "metric",
        headerName: "Metric",
        width: 170,
        // With v2 off, the column is as on main: the plain label, cut off if long.
        valueFormatter: (value) => (hostedV2 ? budgetMetricLabel(value) : metricLabel(value)),
        ...(hostedV2
          ? {
              // Wraps rather than cutting off "Daily AI calls per person" (tech lead, on the fix list).
              renderCell: ({ formattedValue }: { formattedValue?: unknown }) => (
                <Stack justifyContent="center" sx={{ height: "100%" }}>
                  <Typography variant="body2" sx={{ whiteSpace: "normal", lineHeight: 1.3 }}>
                    {String(formattedValue ?? "")}
                  </Typography>
                </Stack>
              ),
            }
          : {}),
      },
      {
        field: "model",
        headerName: "Model",
        width: 160,
        valueFormatter: (value: string) => value || "Every model",
      },
      {
        field: "spent",
        headerName: "Spent this period",
        flex: 1,
        minWidth: 220,
        sortable: false,
        renderCell: ({ row }) =>
          row.metric === "hosted_ai_calls" ? (
            // Each person's box counts and applies its own cap (L1b), so a
            // workspace total would mean nothing here.
            <Stack justifyContent="center" sx={{ height: "100%" }}>
              {/* Wraps rather than cutting off (designer's fix list, item 5). */}
              <Typography variant="body2" sx={{ whiteSpace: "normal", lineHeight: 1.3 }}>
                {formatAmount(row.amount_limit)} a day for each person, applied by their box
              </Typography>
            </Stack>
          ) : (
          <Stack justifyContent="center" sx={{ height: "100%" }} spacing={0.5}>
            <Typography variant="body2">
              {formatAmount(row.spent)} of {formatAmount(row.amount_limit)} per{" "}
              {formatPeriod(row.period_hours)}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={Math.min(100, (row.spent / row.amount_limit) * 100)}
              color={row.exhausted ? "error" : "primary"}
            />
          </Stack>
          ),
      },
      {
        field: "resets_at",
        headerName: "Resets",
        width: 180,
        valueFormatter: (value: string) => formatDateTime(value),
      },
      {
        field: "exhausted",
        headerName: "Status",
        width: 120,
        renderCell: ({ row }) =>
          row.metric === "hosted_ai_calls" ? (
            "—"
          ) : row.exhausted ? (
            <Chip size="small" color="error" label="Reached" />
          ) : (
            <Chip size="small" variant="outlined" label="Within" />
          ),
      },
      {
        field: "actions",
        headerName: "",
        width: 100,
        sortable: false,
        filterable: false,
        renderCell: ({ row }) => (
          <>
            <Tooltip title="Edit">
              <IconButton size="small" onClick={() => openEditor(row)}>
                <EditOutlined fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Remove">
              <IconButton size="small" onClick={() => setDeleteTarget(row)}>
                <DeleteOutline fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        ),
      },
    ],
    [openEditor, hostedV2],
  );

  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1}>
        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            Budgets
          </Typography>
          <Typography variant="body2" color="text.secondary">
            An agent that reaches a budget stops taking work until it resets. People are
            never stopped. No budget means no limit.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddCircleOutline />} onClick={() => openEditor(null)}>
          Add budget
        </Button>
      </Stack>
      {loading ? (
        <CircularProgress />
      ) : error ? (
        <Alert severity="error">Could not load budgets.</Alert>
      ) : (
        <Box sx={{ display: "flex", flexDirection: "column", height: Math.min(420, 108 + (budgets?.length ?? 0) * 56) }}>
          <DataTable rows={budgets ?? []} columns={columns} fillHeight pageSize={10} />
        </Box>
      )}

      <BudgetDialog
        tenantId={tenantId}
        budget={editing}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={refetch}
      />

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Remove budget</DialogTitle>
        <DialogContent>
          {deleteError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {deleteError}
            </Alert>
          )}
          <DialogContentText>
            Remove the {deleteTarget ? (hostedV2 ? budgetMetricLabel : metricLabel)(deleteTarget.metric).toLowerCase() : ""} budget
            for {deleteTarget?.agent_id === null ? "every agent" : deleteTarget?.agent_name}? What
            it covers will no longer be limited.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={handleDelete}
            disabled={deleting}
            startIcon={deleting ? <CircularProgress size={16} /> : undefined}
          >
            Remove
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

type HostedRow = HostedUsagePerson & { id: string };

/** Hosted agents this month (visibility L1, spec A3): awake hours, AI calls and
 * the daily AI cap each person's box applies. Counts only. Hidden when the
 * server has no hosted view. */
export function HostedUsageSection({ tenantId }: { tenantId: string }) {
  const { data, loading, error } = useHostedUsage(tenantId);
  const { data: budgets } = useBudgets(tenantId);
  const setCap =
    budgets?.find((b) => b.metric === "hosted_ai_calls" && b.agent_id === null)?.amount_limit ??
    null;
  const rows = useMemo<HostedRow[]>(
    () => (data?.usage?.people ?? []).map((p) => ({ ...p, id: p.user_id })),
    [data],
  );
  const columns = useMemo<GridColDef<HostedRow>[]>(
    () => [
      { field: "name", headerName: "Person", flex: 1, minWidth: 180 },
      {
        field: "awake_hours",
        headerName: "Awake time",
        // Wide enough for the whole heading plus the grid's sort and menu icons (designer: it read "Awake ti…" at 140).
        width: 170,
        valueFormatter: (value: number) => hoursLabel(value),
      },
      {
        field: "ai_calls",
        headerName: "AI calls",
        type: "number",
        width: 120,
        valueFormatter: (value: number) => formatAmount(value),
      },
      {
        field: "cap_in_force",
        headerName: "Daily AI cap",
        flex: 1,
        minWidth: 220,
        sortable: false,
        valueGetter: (_value, row) => capLine(row, setCap) ?? "Not set",
      },
    ],
    [setCap],
  );
  if (loading) return <CircularProgress />;
  if (error)
    return (
      <Alert severity="error">Couldn't load hosted agents' usage. Reload the page to try again.</Alert>
    );
  if (!data?.usage) return null;
  return (
    <Box>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        Hosted agents this month
      </Typography>
      <Typography variant="body2" color="text.secondary" mb={1}>
        Awake time and AI calls for each person in this workspace, counts only.
      </Typography>
      <Box sx={{ display: "flex", flexDirection: "column", height: Math.min(420, 108 + rows.length * 52) }}>
        <DataTable rows={rows} columns={columns} fillHeight pageSize={10} />
      </Box>
    </Box>
  );
}

function UsageSection({ tenantId }: { tenantId: string }) {
  const [windowHours, setWindowHours] = useState(WINDOWS[0].hours);
  const [since, until] = useMemo(() => {
    const end = new Date();
    return [new Date(end.getTime() - windowHours * 3600 * 1000), end];
  }, [windowHours]);
  const { data: totals, loading, error } = useUsage(tenantId, since, until);

  const rows = useMemo<UsageRow[]>(
    () =>
      (totals ?? []).map((t) => ({ ...t, id: `${t.metric}:${t.client_id}:${t.model}` })),
    [totals],
  );

  const columns = useMemo<GridColDef<UsageRow>[]>(
    () => [
      {
        field: "client_name",
        headerName: "Consumer",
        flex: 1,
        minWidth: 200,
        valueGetter: (_value, row) => row.client_name ?? `Deleted (${row.client_id})`,
      },
      {
        field: "client_type",
        headerName: "Kind",
        width: 120,
        valueFormatter: (value: string | null) => value ?? "—",
      },
      {
        field: "metric",
        headerName: "Metric",
        width: 180,
        valueFormatter: (value) => metricLabel(value),
      },
      {
        field: "model",
        headerName: "Model",
        width: 180,
        valueFormatter: (value: string) => value || "—",
      },
      {
        field: "amount",
        headerName: "Amount",
        type: "number",
        width: 140,
        valueFormatter: (value: number) => formatAmount(value),
      },
    ],
    [],
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 320 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1}>
        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            What was spent
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Counted in whole hours. Tokens appear only for sessions that report them.
          </Typography>
        </Box>
        <TextField
          select
          size="small"
          value={windowHours}
          onChange={(e) => setWindowHours(Number(e.target.value))}
          sx={{ width: 200 }}
        >
          {WINDOWS.map((w) => (
            <MenuItem key={w.hours} value={w.hours}>
              {w.label}
            </MenuItem>
          ))}
        </TextField>
      </Stack>
      {loading ? (
        <CircularProgress />
      ) : error ? (
        <Alert severity="error">Could not load usage.</Alert>
      ) : (
        <DataTable rows={rows} columns={columns} fillHeight pageSize={25} />
      )}
    </Box>
  );
}
