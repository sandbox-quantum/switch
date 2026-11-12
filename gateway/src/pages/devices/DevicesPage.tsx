import AddCircleOutline from "@mui/icons-material/AddCircleOutline";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import EditOutlined from "@mui/icons-material/EditOutlined";
import LinkOffOutlined from "@mui/icons-material/LinkOffOutlined";
import PauseCircleOutline from "@mui/icons-material/PauseCircleOutline";
import PlayCircleOutline from "@mui/icons-material/PlayCircleOutline";
import RefreshOutlined from "@mui/icons-material/RefreshOutlined";
import RestartAltOutlined from "@mui/icons-material/RestartAltOutlined";
import StopCircleOutlined from "@mui/icons-material/StopCircleOutlined";
import {
  Alert,
  Box,
  Button,
  Card,
  CircularProgress,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import DataTable, { TableEmptyState } from "../../components/DataTable";
import InfoTip from "../../components/InfoTip";
import PageBanner from "../../components/PageBanner";
import type { RowAction } from "../../components/RowActionsMenu";
import { useAuth } from "../../data/AuthContext";
import { deleteAgent } from "../../data/api";
import { listScopeOf } from "../../data/listScope";
import {
  type CloudMachine,
  type CloudMachineAction,
  type Controller,
  type ManagedAgent,
  type Operation,
  type ProviderInfo,
  type WorkspaceDevices,
  cloudMachineLifecycle,
  createOperation,
  fetchCloudMachines,
  fetchControllers,
  fetchManagedAgents,
  fetchProviders,
  fetchWorkspaceDevices,
  providerLabel,
  revokeController,
  unmanageAgent,
  updateManagedAgent,
} from "../../data/management";
import { absoluteTitle, formatRelative } from "../../theme/format";
import AddMachineDialog from "../machines/AddMachineDialog";
import EditMachineDialog from "../machines/EditMachineDialog";
import ManagedAgentDialog from "../machines/ManagedAgentDialog";
import { cloudPresentation } from "./cloudMachine";
import DevicesTable, { type DeviceTableRow } from "./DevicesTable";
import ManagedAgentsTable, { type ManagedAgentTableRow, managedAgentRows } from "./ManagedAgentsTable";

const REFRESH_MS = 5_000;

/** Switch names and removes a cloud device, so nobody else may. */
const CLOUD_MANAGED = "Switch manages cloud devices.";

const CLOUD_ACTIONS: Record<CloudMachineAction, { label: string; icon: ReactNode; done: string }> = {
  stop: { label: "Stop", icon: <StopCircleOutlined fontSize="small" />, done: "Stopping your cloud device." },
  start: { label: "Start", icon: <PlayCircleOutline fontSize="small" />, done: "Starting your cloud device." },
  retry: { label: "Retry", icon: <RestartAltOutlined fontSize="small" />, done: "Retrying your cloud device." },
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Why a device can't be asked anything now, or null when it can. */
function unreachable(name: string, state: string): string | null {
  if (state === "online") return null;
  if (state === "unknown") return `${name} has never connected.`;
  if (state === "revoked") return `${name} was removed.`;
  return `${name} is offline.`;
}

/** What an operation's owner needs to know of it: the failure, or that it worked. */
function operationOutcome(operation: Operation): string {
  const error = operation.result?.error as { message?: string } | undefined;
  if (operation.state === "failed") return error?.message ?? "Failed";
  if (operation.state === "succeeded") return "Done";
  if (operation.state === "claimed") return "In progress";
  return operation.state.charAt(0).toUpperCase() + operation.state.slice(1);
}

/** The owner's cloud machine as a device row: on the row of the controller it
 *  enrolled as here, or a row of its own until it has. */
export function withCloud(
  devices: readonly DeviceTableRow[],
  clouds: readonly CloudMachine[],
  owner: { id: string; name: string },
  now: number,
): DeviceTableRow[] {
  const rows = [...devices];
  for (const machine of clouds) {
    const cloud = cloudPresentation(machine, now);
    const at = rows.findIndex((row) => row.id === machine.controller_id);
    if (at >= 0) {
      rows[at] = { ...rows[at], cloud };
      continue;
    }
    rows.push({
      id: `cloud:${machine.machine_id}`,
      name: "Switch cloud",
      description: null,
      kind: "ec2",
      type: "cloud",
      platform: null,
      version: null,
      state: "unknown",
      last_seen_at: machine.heartbeat_at,
      created_at: "",
      owner_id: owner.id,
      owner_name: owner.name,
      providers: [],
      agents_total: 0,
      agents_running: 0,
      can_edit: false,
      can_recheck: false,
      can_remove: false,
      cloud,
    });
  }
  return rows;
}

/** The workspace's devices and the agents managed on them, or a member's
 *  own: everyone's to an admin, who removes any of them, and each person's
 *  own to edit and run. */
export default function DevicesPage() {
  const { session, capabilities } = useAuth();
  const tenant = session?.tenant;
  if (!session || !tenant) return <CircularProgress />;

  const scope = listScopeOf(capabilities);
  return (
    <Devices
      // A change of role changes what the lists hold; start them again.
      key={scope}
      showOwner={scope === "workspace"}
      userId={session.user.id}
      userName={session.user.name}
      workspace={tenant.name}
    />
  );
}

interface Notice {
  severity: "success" | "warning" | "error";
  text: string;
}

function Devices({
  showOwner,
  userId,
  userName,
  workspace,
}: {
  showOwner: boolean;
  userId: string;
  userName: string;
  workspace: string;
}) {
  const [data, setData] = useState<WorkspaceDevices | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [clouds, setClouds] = useState<CloudMachine[]>([]);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // The caller's own devices and agents, in full, read when a dialog that
  // edits one opens: the lists above carry only what the tables show.
  const [own, setOwn] = useState<{ controllers: Controller[]; agents: ManagedAgent[] } | null>(null);
  const [editingDevice, setEditingDevice] = useState<Controller | null>(null);
  const [editingAgent, setEditingAgent] = useState<ManagedAgent | "new" | null>(null);
  // What each confirmation shows, kept after it closes so it fades out with
  // its words; the `…Open` flags alone open and close them.
  const [removing, setRemoving] = useState<DeviceTableRow | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [unmanaging, setUnmanaging] = useState<ManagedAgentTableRow | null>(null);
  const [unmanageOpen, setUnmanageOpen] = useState(false);
  const [deleting, setDeleting] = useState<ManagedAgentTableRow | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    const [devices, cloud] = await Promise.allSettled([fetchWorkspaceDevices(), fetchCloudMachines()]);
    // Two loads in flight can answer out of order; only the latest is kept.
    if (mine !== latest.current) return;
    if (devices.status === "fulfilled") {
      setData(devices.value);
      setLoadError(null);
    } else {
      setLoadError(errorMessage(devices.reason));
    }
    if (cloud.status === "fulfilled") {
      setClouds(cloud.value);
      setCloudError(null);
    } else {
      setCloudError(errorMessage(cloud.reason));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    fetchProviders().then(setProviders, (err) =>
      setProvidersError(`Couldn't load the list of agent providers, so they show by id: ${errorMessage(err)}`),
    );
  }, []);

  const label = useCallback((provider: string) => providerLabel(providers ?? [], provider), [providers]);

  const act = useCallback(
    async (done: string, action: () => Promise<unknown>) => {
      try {
        await action();
        setNotice({ severity: "success", text: done });
      } catch (err) {
        setNotice({ severity: "error", text: errorMessage(err) });
      }
      await load();
    },
    [load],
  );

  /** Read the caller's own devices and agents, for a dialog that edits one. */
  const loadOwn = useCallback(async () => {
    try {
      const [controllers, agents] = await Promise.all([fetchControllers(), fetchManagedAgents()]);
      const loaded = { controllers, agents };
      setOwn(loaded);
      return loaded;
    } catch (err) {
      setNotice({ severity: "error", text: `Couldn't load your devices: ${errorMessage(err)}` });
      return null;
    }
  }, []);

  const deviceRows = useMemo(
    () => withCloud(data?.devices ?? [], clouds, { id: userId, name: userName }, Date.now()),
    [data, clouds, userId, userName],
  );
  const machineOf = useMemo(() => {
    const byRow = new Map<string, CloudMachine>();
    for (const machine of clouds) {
      const row = deviceRows.find((r) => r.id === machine.controller_id) ?? deviceRows.find((r) => r.id === `cloud:${machine.machine_id}`);
      if (row) byRow.set(row.id, machine);
    }
    return byRow;
  }, [clouds, deviceRows]);
  const agentRows = useMemo(() => managedAgentRows(data?.managed_agents ?? []), [data]);

  const deviceActions = useCallback(
    (row: DeviceTableRow): RowAction[] => {
      const actions: RowAction[] = [];
      const cloudOfYours = row.type === "cloud" && row.owner_id === userId;
      if (row.can_recheck) {
        actions.push({
          label: "Refresh",
          icon: <RefreshOutlined fontSize="small" />,
          disabledReason:
            unreachable(row.name, row.state) ??
            (row.providers.length === 0 ? `${row.name} hasn't reported its agent providers yet.` : null),
          onClick: () =>
            void act(`Asked ${row.name} to report in.`, () =>
              Promise.all(
                row.providers.map((provider) =>
                  createOperation({
                    controller_id: row.id,
                    agent_id: null,
                    kind: "provider.recheck",
                    params: { provider },
                  }),
                ),
              ),
            ),
        });
      }
      const machine = machineOf.get(row.id);
      if (machine && row.cloud) {
        for (const action of row.cloud.actions) {
          const meta = CLOUD_ACTIONS[action];
          actions.push({
            label: meta.label,
            icon: meta.icon,
            onClick: () => void act(meta.done, () => cloudMachineLifecycle(machine.machine_id, action, machine.revision)),
          });
        }
      }
      if (row.can_edit || cloudOfYours) {
        actions.push({
          label: "Edit",
          icon: <EditOutlined fontSize="small" />,
          disabledReason: row.can_edit ? null : CLOUD_MANAGED,
          onClick: async () => {
            const loaded = await loadOwn();
            const controller = loaded?.controllers.find((c) => c.id === row.id);
            if (controller) setEditingDevice(controller);
            else if (loaded) setNotice({ severity: "error", text: `${row.name} is no longer one of your devices.` });
          },
        });
      }
      if (row.can_remove || cloudOfYours) {
        actions.push({
          label: "Remove",
          icon: <DeleteOutline fontSize="small" />,
          destructive: true,
          disabledReason: row.can_remove ? null : CLOUD_MANAGED,
          onClick: () => {
            setRemoving(row);
            setRemoveOpen(true);
          },
        });
      }
      return actions;
    },
    [act, loadOwn, machineOf, userId],
  );

  const agentActions = useCallback(
    (row: ManagedAgentTableRow): RowAction[] => {
      const actions: RowAction[] = [];
      const name = row.display_name ?? row.name;
      if (row.can_edit) {
        const blocked =
          row.controller_id === null
            ? "It isn't on a device. Edit it to put it on one."
            : unreachable(row.controller_name ?? "Its device", row.controller_state ?? "unknown");
        const running = row.desired_state === "running";
        actions.push({
          label: running ? "Pause" : "Start",
          icon: running ? <PauseCircleOutline fontSize="small" /> : <PlayCircleOutline fontSize="small" />,
          disabledReason: blocked,
          onClick: () =>
            void act(running ? `Pausing ${name}.` : `Starting ${name}.`, () =>
              updateManagedAgent(row.agent_id, { desired_state: running ? "stopped" : "running" }),
            ),
        });
        actions.push({
          label: "Restart",
          icon: <RestartAltOutlined fontSize="small" />,
          disabledReason: blocked ?? (running ? null : "It's paused. Start it instead."),
          onClick: () =>
            void act(`Asked to restart ${name}.`, () =>
              createOperation({
                controller_id: row.controller_id as string,
                agent_id: row.agent_id,
                kind: "agent.restart",
                params: {},
              }),
            ),
        });
        actions.push({
          label: "Edit",
          icon: <EditOutlined fontSize="small" />,
          onClick: async () => {
            const loaded = await loadOwn();
            const agent = loaded?.agents.find((a) => a.agent_id === row.agent_id);
            if (agent) setEditingAgent(agent);
            else if (loaded) setNotice({ severity: "error", text: `${name} is no longer one of your managed agents.` });
          },
        });
      }
      if (row.can_delete) {
        actions.push({
          label: "Stop managing",
          icon: <LinkOffOutlined fontSize="small" />,
          onClick: () => {
            setUnmanaging(row);
            setUnmanageOpen(true);
          },
        });
        actions.push({
          label: "Delete",
          icon: <DeleteOutline fontSize="small" />,
          destructive: true,
          onClick: () => {
            setDeleting(row);
            setDeleteOpen(true);
          },
        });
      }
      return actions;
    },
    [act, loadOwn],
  );

  const deviceNames = useMemo(() => new Map(deviceRows.map((row) => [row.id, row.name])), [deviceRows]);
  const agentNames = useMemo(() => new Map(agentRows.map((row) => [row.agent_id, row.display_name ?? row.name])), [agentRows]);
  const operationColumns = useMemo<GridColDef<Operation>[]>(
    () => [
      {
        field: "kind",
        headerName: "Operation",
        width: 160,
        valueGetter: (value) => (value === "agent.restart" ? "Restart" : value === "provider.recheck" ? "Re-check" : value),
      },
      {
        field: "target",
        headerName: "Target",
        flex: 1,
        minWidth: 160,
        valueGetter: (_value, row) =>
          (row.agent_id ? agentNames.get(row.agent_id) : null) ??
          `${deviceNames.get(row.controller_id) ?? "A removed device"}${row.params.provider ? ` · ${label(String(row.params.provider))}` : ""}`,
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
    [agentNames, deviceNames, label],
  );
  const recentOperations = useMemo(
    () => [...(data?.operations ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 10),
    [data],
  );

  const emptyDevices = (
    <Card variant="outlined" sx={{ borderRadius: "16px" }}>
      <Box sx={{ px: 3, py: 6, textAlign: "center" }}>
        <TableEmptyState title={showOwner ? "No devices yet" : `You have no devices in ${workspace} yet`}>
          Add one to start running agents.
        </TableEmptyState>
      </Box>
    </Card>
  );
  const emptyAgents = (
    <Card variant="outlined" sx={{ borderRadius: "16px" }}>
      <Box sx={{ px: 3, py: 6, textAlign: "center" }}>
        <TableEmptyState title="No managed agents yet">Place one on a device to get started.</TableEmptyState>
      </Box>
    </Card>
  );

  let body: ReactNode;
  if (data === null && loadError === null) {
    body = <CircularProgress aria-label="Loading devices" />;
  } else if (data === null) {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void load()}>
            Retry
          </Button>
        }
      >
        Couldn't load the devices: {loadError}
      </Alert>
    );
  } else {
    body = (
      <Stack spacing={4}>
        <DevicesTable rows={deviceRows} showOwner={showOwner} actionsFor={deviceActions} emptyState={emptyDevices} />
        <Box>
          <Stack direction="row" spacing={2} sx={{ alignItems: "center", justifyContent: "space-between", mb: 2 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
                Managed agents
              </Typography>
              <InfoTip>"Wanted" is what its owner asked for; "Actual" is what its device last reported.</InfoTip>
            </Stack>
            <Button
              variant="outlined"
              startIcon={<AddCircleOutline />}
              onClick={async () => {
                if (await loadOwn()) setEditingAgent("new");
              }}
            >
              New managed agent
            </Button>
          </Stack>
          <ManagedAgentsTable
            rows={agentRows}
            showOwner={showOwner}
            providerLabel={label}
            actionsFor={agentActions}
            emptyState={emptyAgents}
          />
        </Box>
        <Box>
          <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600, mb: 2 }}>
            Recent operations
          </Typography>
          <DataTable
            rows={recentOperations}
            columns={operationColumns}
            height={108 + 52 * Math.max(1, recentOperations.length)}
            pageSize={10}
            emptyState={
              <TableEmptyState title="Nothing sent to a device yet">
                What Switch asks a device to do is listed here.
              </TableEmptyState>
            }
          />
        </Box>
      </Stack>
    );
  }

  const removingOthers = removing !== null && removing.owner_id !== userId;
  const removingReach = removing ? unreachable(removing.name, removing.state) : null;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start", justifyContent: "space-between", mb: 3 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h5">Devices</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {showOwner
              ? `The devices that run agents in ${workspace}.`
              : `Your devices that run agents in ${workspace}.`}
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddCircleOutline />} onClick={() => setAddOpen(true)}>
          Add device
        </Button>
      </Stack>

      <Stack spacing={2} sx={{ mb: 2, "&:empty": { display: "none" } }}>
        {data !== null && loadError !== null && (
          <PageBanner
            tone="warning"
            action={
              <Button color="inherit" size="small" onClick={() => void load()}>
                Retry
              </Button>
            }
          >
            Couldn't refresh the devices: {loadError}. This is the list as last loaded.
          </PageBanner>
        )}
        {cloudError !== null && (
          <PageBanner tone="warning">Couldn't read your cloud device, so it may be missing: {cloudError}</PageBanner>
        )}
        {providersError !== null && <PageBanner tone="warning">{providersError}</PageBanner>}
        {notice && (
          <Alert severity={notice.severity} onClose={() => setNotice(null)}>
            {notice.text}
          </Alert>
        )}
      </Stack>

      {body}

      <AddMachineDialog open={addOpen} onClose={() => setAddOpen(false)} />

      <EditMachineDialog
        machine={editingDevice}
        onClose={() => setEditingDevice(null)}
        onSaved={(saved) => {
          setNotice({ severity: "success", text: `Saved ${saved.name}.` });
          void load();
        }}
      />

      <ManagedAgentDialog
        open={editingAgent !== null}
        agent={editingAgent === "new" ? null : editingAgent}
        controllers={own?.controllers ?? []}
        providers={providers ?? []}
        onClose={() => setEditingAgent(null)}
        onSaved={() => void load()}
      />

      <ConfirmDialog
        open={removeOpen}
        title="Remove device"
        tone="destructive"
        confirmLabel="Remove"
        description={
          removing && (
            <>
              {removingOthers ? `${removing.owner_name}'s device ` : ""}
              {removing.name} stops running agents and can't reconnect to Switch.{" "}
              {removing.agents_total === 0
                ? "No agents are placed on it."
                : removing.agents_total === 1
                  ? "The agent on it stops, and runs again once it's put on another device."
                  : `The ${removing.agents_total} agents on it stop, and run again once they're put on another device.`}{" "}
              {removingReach && `${removingReach} It finds out when it next connects. `}
              This can't be undone.
            </>
          )
        }
        onClose={() => setRemoveOpen(false)}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await revokeController(removing.id);
          } finally {
            void load();
          }
          setNotice({ severity: "success", text: `Removed ${removing.name}.` });
        }}
      />

      <ConfirmDialog
        open={unmanageOpen}
        title="Stop managing agent"
        tone="destructive"
        confirmLabel="Stop managing"
        description={
          unmanaging &&
          `Stop managing ${unmanaging.display_name ?? unmanaging.name}? ${
            unmanaging.controller_name ? `It stops running on ${unmanaging.controller_name}. ` : ""
          }The agent itself stays, with its rooms, and can be managed again later.`
        }
        onClose={() => setUnmanageOpen(false)}
        onConfirm={async () => {
          if (!unmanaging) return;
          try {
            await unmanageAgent(unmanaging.agent_id);
          } finally {
            void load();
          }
          setNotice({ severity: "success", text: `Stopped managing ${unmanaging.display_name ?? unmanaging.name}.` });
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="Delete agent"
        tone="destructive"
        confirmLabel="Delete"
        description={
          deleting &&
          `Delete ${deleting.display_name ?? deleting.name}? ${
            deleting.controller_name ? `It stops running on ${deleting.controller_name}, and its` : "Its"
          } tools and models are removed. This can't be undone.`
        }
        onClose={() => setDeleteOpen(false)}
        onConfirm={async () => {
          if (!deleting) return;
          const name = deleting.display_name ?? deleting.name;
          let failures: string[];
          try {
            failures = (await deleteAgent(deleting.agent_id)).bridge_cleanup_failures;
          } finally {
            void load();
          }
          setNotice(
            failures.length > 0
              ? {
                  severity: "warning",
                  text: `Deleted ${name}, but its chat platform clean-up did not finish (${failures.join("; ")}). It finishes when that bridge next starts.`,
                }
              : { severity: "success", text: `Deleted ${name}.` },
          );
        }}
      />
    </Box>
  );
}
