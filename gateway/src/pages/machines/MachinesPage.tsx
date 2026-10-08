import AddCircleOutline from "@mui/icons-material/AddCircleOutline";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import EditOutlined from "@mui/icons-material/EditOutlined";
import PauseCircleOutline from "@mui/icons-material/PauseCircleOutline";
import PlayCircleOutline from "@mui/icons-material/PlayCircleOutline";
import RefreshOutlined from "@mui/icons-material/RefreshOutlined";
import RestartAltOutlined from "@mui/icons-material/RestartAltOutlined";
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
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useCallback, useEffect, useMemo, useState } from "react";
import DataTable from "../../components/DataTable";
import {
  type Controller,
  type ControllerState,
  createOperation,
  fetchControllers,
  fetchManagedAgents,
  fetchOperations,
  type ManagedAgent,
  ManagementApiError,
  type Operation,
  PROVIDERS,
  type ProviderStatus,
  revokeController,
  unmanageAgent,
  updateManagedAgent,
} from "../../data/management";
import { EM_DASH, absoluteTitle, formatRelative } from "../../theme/hootFormat";
import AddMachineDialog from "./AddMachineDialog";
import EditMachineDialog from "./EditMachineDialog";
import ManagedAgentDialog from "./ManagedAgentDialog";

const REFRESH_MS = 5_000;

const STATE_COLOR: Record<ControllerState, "success" | "warning" | "default"> = {
  online: "success",
  offline: "warning",
  unknown: "default",
  revoked: "default",
};

const DISCONNECT_REASON: Record<string, string> = {
  socket_closed: "its controller stopped or lost its connection",
  heartbeat_lapsed: "its connection stopped responding",
  server_shutdown: "the Switch server it was connected to restarted",
  server_lost: "the Switch server it was connected to stopped responding",
  taken_over: "another instance of its controller took over",
  revoked: "it was removed",
};

/** What the state chip says on hover: when the machine connected, or when and why it stopped. */
function stateTitle(row: Controller): string {
  const connection = row.connection;
  if (row.state === "revoked") return "Removed from Switch.";
  if (row.state === "unknown" || connection === null)
    return "Has never connected to Switch. Start its controller with switch-agent-controller run.";
  if (row.state === "online") return `Connected since ${absoluteTitle(connection.connected_at)}`;
  const why = connection.disconnect_reason
    ? (DISCONNECT_REASON[connection.disconnect_reason] ?? connection.disconnect_reason)
    : null;
  const when =
    connection.disconnected_at !== null ? ` ${formatRelative(connection.disconnected_at)}` : "";
  return `Disconnected${when}${why ? `: ${why}` : ""}.`;
}

/**
 * The last time Switch heard from the machine at all: now while it is connected, else the
 * latest of its status report, its socket attaching and its socket going.
 */
function lastContact(row: Controller): string | null {
  if (row.state === "online") return new Date().toISOString();
  const times = [row.last_seen_at, row.connection?.connected_at, row.connection?.disconnected_at]
    .filter((t): t is string => typeof t === "string")
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  return times[0] ?? null;
}

const PROCESS_COLOR: Record<string, "success" | "warning" | "error" | "default"> = {
  running: "success",
  starting: "warning",
  pending: "warning",
  restarting: "warning",
  stopping: "default",
  stopped: "default",
  crashed: "error",
  failed: "error",
};

function providerLabel(provider: string): string {
  return PROVIDERS.find((p) => p.value === provider)?.label ?? provider;
}

function providerChip(status: ProviderStatus) {
  const ok = status.installed && status.auth === "ok";
  const problem = !status.installed
    ? "not installed"
    : status.auth === "ok"
      ? null
      : `login ${status.auth}`;
  const title = [
    status.version ? `Version ${status.version}` : null,
    status.reason ?? null,
    `Checked ${formatRelative(status.checked_at)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Tooltip key={status.provider} title={title}>
      <Chip
        size="small"
        variant="outlined"
        color={ok ? "success" : status.installed ? "warning" : "default"}
        label={problem ? `${providerLabel(status.provider)}: ${problem}` : providerLabel(status.provider)}
      />
    </Tooltip>
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The result line an operation's owner needs: the failure, or that it worked. */
function operationOutcome(operation: Operation): string {
  const error = operation.result?.error as { message?: string } | undefined;
  if (operation.state === "failed") return error?.message ?? "Failed";
  if (operation.state === "succeeded") return "Done";
  if (operation.state === "claimed") return "In progress";
  return operation.state.charAt(0).toUpperCase() + operation.state.slice(1);
}

export default function MachinesPage() {
  const [controllers, setControllers] = useState<Controller[] | null>(null);
  const [agents, setAgents] = useState<ManagedAgent[] | null>(null);
  const [operations, setOperations] = useState<Operation[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ severity: "success" | "error"; text: string } | null>(
    null,
  );
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedAgent | null | "new">(null);
  const [revokeTarget, setRevokeTarget] = useState<Controller | null>(null);
  const [machineTarget, setMachineTarget] = useState<Controller | null>(null);
  const [unmanageTarget, setUnmanageTarget] = useState<ManagedAgent | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, a, o] = await Promise.all([
        fetchControllers(),
        fetchManagedAgents(),
        fetchOperations(),
      ]);
      setControllers(c);
      setAgents(a);
      setOperations(o);
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof ManagementApiError && err.status === 404 && err.code === "http_error"
          ? "Agent management is not enabled on this server. An operator turns it on with AGENT_MANAGEMENT_ENABLED."
          : `Could not load machines and managed agents: ${errorMessage(err)}`,
      );
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const act = useCallback(
    async (what: string, action: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await action();
        setNotice({ severity: "success", text: what });
        await load();
      } catch (err) {
        setNotice({ severity: "error", text: errorMessage(err) });
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const controllerName = useCallback(
    (id: string | null) =>
      id === null ? null : (controllers?.find((c) => c.id === id)?.name ?? id),
    [controllers],
  );

  const machineColumns = useMemo<GridColDef<Controller>[]>(
    () => [
      {
        field: "name",
        headerName: "Machine",
        flex: 1,
        minWidth: 160,
        renderCell: ({ row }) =>
          row.description ? (
            <Tooltip title={row.description}>
              <Stack justifyContent="center" sx={{ height: "100%", lineHeight: 1.3, overflow: "hidden" }}>
                <Typography variant="body2" noWrap>
                  {row.name}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap>
                  {row.description}
                </Typography>
              </Stack>
            </Tooltip>
          ) : (
            row.name
          ),
      },
      {
        field: "state",
        headerName: "State",
        width: 110,
        renderCell: ({ row }) => (
          <Tooltip title={stateTitle(row)}>
            <Chip size="small" color={STATE_COLOR[row.state] ?? "default"} label={row.state} />
          </Tooltip>
        ),
      },
      {
        field: "platform",
        headerName: "Platform",
        width: 150,
        valueGetter: (_value, row) =>
          row.platform ? `${row.platform.os} ${row.platform.arch}` : EM_DASH,
      },
      {
        field: "providers",
        headerName: "Providers",
        flex: 1.5,
        minWidth: 240,
        sortable: false,
        renderCell: ({ row }) => {
          if (!row.status || row.status.providers.length === 0)
            return (
              <Typography variant="body2" color="text.secondary">
                Not reported yet
              </Typography>
            );
          const installed = row.status.providers.filter((p) => p.installed);
          const missing = row.status.providers.filter((p) => !p.installed);
          return (
            <Stack direction="row" spacing={0.5} alignItems="center" sx={{ height: "100%", overflow: "hidden" }}>
              {installed.map(providerChip)}
              {missing.length > 0 && (
                <Tooltip title={`Not installed: ${missing.map((p) => providerLabel(p.provider)).join(", ")}`}>
                  <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
                    +{missing.length} not installed
                  </Typography>
                </Tooltip>
              )}
            </Stack>
          );
        },
      },
      {
        field: "agents",
        headerName: "Agents running",
        width: 130,
        valueGetter: (_value, row) =>
          row.state === "revoked"
            ? "None (revoked)"
            : row.state === "offline"
              ? "Not connected"
              : row.state === "unknown"
                ? "Unknown"
                : row.status
                ? `${row.status.agents.filter((a) => a.process === "running").length} / ${row.status.agents.length}`
                : EM_DASH,
      },
      {
        field: "last_seen_at",
        headerName: "Last seen",
        width: 130,
        valueGetter: (_value, row) => lastContact(row),
        renderCell: ({ row }) => (
          <Tooltip title={absoluteTitle(lastContact(row))}>
            <span>{formatRelative(lastContact(row))}</span>
          </Tooltip>
        ),
      },
      {
        field: "actions",
        headerName: "",
        width: 130,
        sortable: false,
        filterable: false,
        renderCell: ({ row }) => {
          const providers = row.status?.providers ?? [];
          const live = row.state !== "revoked";
          return (
            <>
              <Tooltip title="Re-check providers">
                <span>
                  <IconButton
                    size="small"
                    aria-label={`Re-check providers on ${row.name}`}
                    disabled={!live || providers.length === 0 || busy}
                    onClick={() =>
                      act(
                        `Asked ${row.name} to re-check ${providers.length} provider(s)`,
                        () =>
                          Promise.all(
                            providers.map((p) =>
                              createOperation({
                                controller_id: row.id,
                                agent_id: null,
                                kind: "provider.recheck",
                                params: { provider: p.provider },
                              }),
                            ),
                          ),
                      )
                    }
                  >
                    <RefreshOutlined fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Rename or describe">
                <IconButton
                  size="small"
                  aria-label={`Edit machine ${row.name}`}
                  onClick={() => setMachineTarget(row)}
                >
                  <EditOutlined fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Revoke">
                <span>
                  <IconButton
                    size="small"
                    aria-label={`Revoke ${row.name}`}
                    disabled={!live || busy}
                    onClick={() => setRevokeTarget(row)}
                  >
                    <DeleteOutline fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </>
          );
        },
      },
    ],
    [act, busy],
  );

  const agentColumns = useMemo<GridColDef<ManagedAgent>[]>(
    () => [
      { field: "name", headerName: "Agent", flex: 1, minWidth: 160 },
      {
        field: "provider",
        headerName: "Provider",
        width: 130,
        valueGetter: (_value, row) => providerLabel(row.definition.provider),
      },
      {
        field: "controller_id",
        headerName: "Machine",
        flex: 1,
        minWidth: 140,
        valueGetter: (_value, row) => controllerName(row.controller_id) ?? "Not placed",
      },
      {
        field: "desired_state",
        headerName: "Wanted",
        width: 110,
        renderCell: ({ row }) => (
          <Chip
            size="small"
            variant="outlined"
            color={row.desired_state === "running" ? "primary" : "default"}
            label={row.desired_state}
          />
        ),
      },
      {
        field: "status",
        headerName: "Actual",
        flex: 1.2,
        minWidth: 200,
        sortable: false,
        renderCell: ({ row }) => {
          if (row.controller_id === null)
            return <Typography variant="body2" color="text.secondary">{EM_DASH}</Typography>;
          if (row.controller_state === "revoked")
            return (
              <Tooltip title="Its machine was revoked, so nothing runs this agent. Move it to another machine to run it again.">
                <Chip size="small" label="not running: machine revoked" />
              </Tooltip>
            );
          if (row.controller_state === "offline")
            return (
              <Tooltip title="Its machine is not connected to Switch, so this agent is not reachable. It runs again once the machine's controller is back.">
                <Chip size="small" color="warning" label="machine offline" />
              </Tooltip>
            );
          if (row.controller_state === "unknown")
            return (
              <Tooltip title="Its machine has never connected to Switch; this agent's state is not known.">
                <Chip size="small" label="unknown" />
              </Tooltip>
            );
          if (!row.status)
            return (
              <Typography variant="body2" color="text.secondary">
                Not reported yet
              </Typography>
            );
          const stale = row.status.applied_revision !== row.revision;
          const detail = [row.status.reason, row.status.detail].filter(Boolean).join(": ");
          return (
            <Stack direction="row" spacing={0.5} alignItems="center" sx={{ height: "100%" }}>
              <Tooltip title={detail || `Since ${absoluteTitle(row.status.since)}`}>
                <Chip
                  size="small"
                  color={PROCESS_COLOR[row.status.process] ?? "default"}
                  label={row.status.reason ? `${row.status.process}: ${row.status.reason}` : row.status.process}
                />
              </Tooltip>
              {stale && (
                <Tooltip title={`Machine is on revision ${row.status.applied_revision ?? "none"}, latest is ${row.revision}`}>
                  <Chip size="small" variant="outlined" label="updating" />
                </Tooltip>
              )}
            </Stack>
          );
        },
      },
      {
        field: "actions",
        headerName: "",
        width: 170,
        sortable: false,
        filterable: false,
        renderCell: ({ row }) => {
          const running = row.desired_state === "running";
          return (
            <>
              <Tooltip title={running ? "Stop" : "Start"}>
                <span>
                  <IconButton
                    size="small"
                    aria-label={`${running ? "Stop" : "Start"} ${row.name}`}
                    disabled={busy || row.controller_id === null}
                    onClick={() =>
                      act(`${running ? "Stopping" : "Starting"} ${row.name}`, () =>
                        updateManagedAgent(row.agent_id, {
                          desired_state: running ? "stopped" : "running",
                        }),
                      )
                    }
                  >
                    {running ? (
                      <PauseCircleOutline fontSize="small" />
                    ) : (
                      <PlayCircleOutline fontSize="small" />
                    )}
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Restart">
                <span>
                  <IconButton
                    size="small"
                    aria-label={`Restart ${row.name}`}
                    disabled={busy || row.controller_id === null || !running}
                    onClick={() =>
                      act(`Asked to restart ${row.name}`, () =>
                        createOperation({
                          controller_id: row.controller_id as string,
                          agent_id: row.agent_id,
                          kind: "agent.restart",
                          params: {},
                        }),
                      )
                    }
                  >
                    <RestartAltOutlined fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Edit">
                <IconButton
                  size="small"
                  aria-label={`Edit ${row.name}`}
                  onClick={() => setEditing(row)}
                >
                  <EditOutlined fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Stop managing">
                <span>
                  <IconButton
                    size="small"
                    aria-label={`Stop managing ${row.name}`}
                    disabled={busy}
                    onClick={() => setUnmanageTarget(row)}
                  >
                    <DeleteOutline fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </>
          );
        },
      },
    ],
    [act, busy, controllerName],
  );

  const agentName = useCallback(
    (id: string | null) =>
      id === null ? null : (agents?.find((a) => a.agent_id === id)?.name ?? id),
    [agents],
  );

  const operationColumns = useMemo<GridColDef<Operation>[]>(
    () => [
      { field: "kind", headerName: "Operation", width: 160 },
      {
        field: "target",
        headerName: "Target",
        flex: 1,
        minWidth: 160,
        valueGetter: (_value, row) =>
          agentName(row.agent_id) ??
          `${controllerName(row.controller_id)}${row.params.provider ? ` · ${providerLabel(String(row.params.provider))}` : ""}`,
      },
      {
        field: "outcome",
        headerName: "Outcome",
        flex: 1.5,
        minWidth: 200,
        valueGetter: (_value, row) => operationOutcome(row),
      },
      {
        field: "created_at",
        headerName: "Asked",
        width: 130,
        renderCell: ({ row }) => (
          <Tooltip title={absoluteTitle(row.created_at)}>
            <span>{formatRelative(row.created_at)}</span>
          </Tooltip>
        ),
      },
    ],
    [agentName, controllerName],
  );

  const recentOperations = useMemo(
    () =>
      [...(operations ?? [])]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 10),
    [operations],
  );

  if (controllers === null && loadError === null) return <CircularProgress />;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {loadError && (
        <Alert severity="error">
          {loadError}
        </Alert>
      )}

      <Box>
        <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1}>
          <Box>
            <Typography variant="h5">Machines</Typography>
            <Typography variant="body2" color="text.secondary">
              Computers running an agents controller. Each one runs the agents you place on it
              and reports what it sees.
            </Typography>
          </Box>
          <Button
            variant="contained"
            startIcon={<AddCircleOutline />}
            onClick={() => setAddOpen(true)}
          >
            Add machine
          </Button>
        </Stack>
        <DataTable rows={controllers ?? []} columns={machineColumns} height={320} pageSize={10} />
      </Box>

      <Box>
        <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1}>
          <Box>
            <Typography variant="h6">Managed agents</Typography>
            <Typography variant="body2" color="text.secondary">
              Agents defined here and run by a machine. "Wanted" is what you asked for;
              "Actual" is what the machine last reported.
            </Typography>
          </Box>
          <Button
            variant="outlined"
            startIcon={<AddCircleOutline />}
            onClick={() => setEditing("new")}
          >
            New managed agent
          </Button>
        </Stack>
        <DataTable
          rows={(agents ?? []).map((a) => ({ ...a, id: a.agent_id }))}
          columns={agentColumns as GridColDef<ManagedAgent & { id: string }>[]}
          height={360}
          pageSize={10}
        />
      </Box>

      <Box>
        <Typography variant="h6" mb={1}>
          Recent operations
        </Typography>
        <DataTable rows={recentOperations} columns={operationColumns} height={300} pageSize={10} />
      </Box>

      <AddMachineDialog open={addOpen} onClose={() => setAddOpen(false)} />

      <EditMachineDialog
        machine={machineTarget}
        onClose={() => setMachineTarget(null)}
        onSaved={(saved) => {
          setNotice({ severity: "success", text: `Saved ${saved.name}` });
          void load();
        }}
      />

      <ManagedAgentDialog
        open={editing !== null}
        agent={editing === "new" ? null : editing}
        controllers={controllers ?? []}
        onClose={() => setEditing(null)}
        onSaved={() => void load()}
      />

      <Dialog open={revokeTarget !== null} onClose={() => setRevokeTarget(null)}>
        <DialogTitle>Revoke {revokeTarget?.name}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            The machine's controller loses access to Switch immediately, and if it is online
            it stops every agent it runs. Agents placed on it stay placed, and offline, until
            you move them to another machine or stop managing them. Enrolling the machine again
            needs a new code.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRevokeTarget(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            disabled={busy}
            onClick={() => {
              const target = revokeTarget;
              setRevokeTarget(null);
              if (target) void act(`Revoked ${target.name}`, () => revokeController(target.id));
            }}
          >
            Revoke
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={unmanageTarget !== null} onClose={() => setUnmanageTarget(null)}>
        <DialogTitle>Stop managing {unmanageTarget?.name}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Its machine stops running it the next time it hears from Switch. The agent itself is
            not deleted: it stays registered, with its rooms, and can be managed again later.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUnmanageTarget(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            disabled={busy}
            onClick={() => {
              const target = unmanageTarget;
              setUnmanageTarget(null);
              if (target)
                void act(`Stopped managing ${target.name}`, () => unmanageAgent(target.agent_id));
            }}
          >
            Stop managing
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={notice !== null}
        autoHideDuration={notice?.severity === "error" ? null : 4000}
        onClose={() => setNotice(null)}
      >
        {notice ? (
          <Alert severity={notice.severity} onClose={() => setNotice(null)}>
            {notice.text}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}
