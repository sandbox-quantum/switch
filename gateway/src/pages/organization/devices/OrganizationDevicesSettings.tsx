import DeleteOutline from "@mui/icons-material/DeleteOutline";
import LinkOffOutlined from "@mui/icons-material/LinkOffOutlined";
import { Alert, Box, Button, Card, CircularProgress, Stack, Typography } from "@mui/material";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "../../../components/ConfirmDialog";
import { TableEmptyState } from "../../../components/DataTable";
import InfoTip from "../../../components/InfoTip";
import PageBanner from "../../../components/PageBanner";
import type { RowAction } from "../../../components/RowActionsMenu";
import {
  type OrganizationDevices,
  type ProviderInfo,
  fetchOrganizationDevices,
  fetchProviders,
  providerLabel,
  removeOrganizationDevice,
  unmanageOrganizationAgent,
} from "../../../data/management";
import DevicesTable, { type DeviceTableRow } from "../../devices/DevicesTable";
import ManagedAgentsTable, { type ManagedAgentTableRow } from "../../devices/ManagedAgentsTable";

/** Slower than one workspace's page: each read is every workspace's. */
const REFRESH_MS = 15_000;

/** Switch names and removes a cloud device, so nobody else may. */
const CLOUD_MANAGED = "Switch manages cloud devices.";

type InWorkspace = { workspace_id: string; workspace_name: string };
type DeviceRow = DeviceTableRow & InWorkspace;
type AgentRow = ManagedAgentTableRow & InWorkspace;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function deviceRows(data: OrganizationDevices | null): DeviceRow[] {
  return data?.devices ?? [];
}

function agentRows(data: OrganizationDevices | null): AgentRow[] {
  return (data?.managed_agents ?? []).map((agent) => ({ ...agent, id: agent.agent_id }));
}

interface Notice {
  severity: "success" | "error";
  text: string;
}

/** Organization settings › Devices: every device and managed agent in the
 * organization's workspaces, with the workspace each is in, for its admins
 * to remove a device or stop managing an agent, as an admin of that
 * workspace may. Adding one, and what only its owner does (editing,
 * pausing, restarting), stay on the workspace's own Devices page. */
export default function OrganizationDevicesSettings({ organizationName }: { organizationName: string }) {
  const [data, setData] = useState<OrganizationDevices | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // What each confirmation shows, kept after it closes so it fades out with
  // its words; the `…Open` flags alone open and close them.
  const [removing, setRemoving] = useState<DeviceRow | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [unmanaging, setUnmanaging] = useState<AgentRow | null>(null);
  const [unmanageOpen, setUnmanageOpen] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const loaded = await fetchOrganizationDevices();
      if (mine !== latest.current) return;
      setData(loaded);
      setLoadError(null);
    } catch (err) {
      if (mine !== latest.current) return;
      setLoadError(errorMessage(err));
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

  const label = useCallback((provider: string) => providerLabel(providers, provider), [providers]);
  const devices = useMemo(() => deviceRows(data), [data]);
  const agents = useMemo(() => agentRows(data), [data]);

  const deviceActions = useCallback((row: DeviceTableRow): RowAction[] => {
    const cloud = row.type === "cloud";
    if (!row.can_remove && !cloud) return [];
    return [
      {
        label: "Remove",
        icon: <DeleteOutline fontSize="small" />,
        destructive: true,
        disabledReason: row.can_remove ? null : CLOUD_MANAGED,
        onClick: () => {
          setRemoving(row as DeviceRow);
          setRemoveOpen(true);
        },
      },
    ];
  }, []);

  const agentActions = useCallback(
    (row: ManagedAgentTableRow): RowAction[] =>
      row.can_delete
        ? [
            {
              label: "Stop managing",
              icon: <LinkOffOutlined fontSize="small" />,
              onClick: () => {
                setUnmanaging(row as AgentRow);
                setUnmanageOpen(true);
              },
            },
          ]
        : [],
    [],
  );

  const empty = (title: string, children: ReactNode) => (
    <Card variant="outlined" sx={{ borderRadius: "16px" }}>
      <Box sx={{ px: 3, py: 6, textAlign: "center" }}>
        <TableEmptyState title={title}>{children}</TableEmptyState>
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
        <DevicesTable
          rows={devices}
          showOwner
          showWorkspace
          actionsFor={deviceActions}
          emptyState={empty("No devices yet", "Devices are added from a workspace's own Devices page.")}
        />
        <Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 2 }}>
            <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
              Managed agents
            </Typography>
            <InfoTip>"Wanted" is what its owner asked for; "Actual" is what its device last reported.</InfoTip>
          </Stack>
          <ManagedAgentsTable
            rows={agents}
            showOwner
            showWorkspace
            providerLabel={label}
            actionsFor={agentActions}
            emptyState={empty("No managed agents yet", "Their owners place them on a device from a workspace's Devices page.")}
          />
        </Box>
      </Stack>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h5">Devices</Typography>
        <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            The devices that run agents across {organizationName}.
          </Typography>
          <InfoTip>
            Each is in one workspace. Add a device, or change what runs on one, from that workspace's own Devices page.
          </InfoTip>
        </Stack>
      </Box>

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
        {providersError !== null && <PageBanner tone="warning">{providersError}</PageBanner>}
        {notice && (
          <Alert severity={notice.severity} onClose={() => setNotice(null)}>
            {notice.text}
          </Alert>
        )}
      </Stack>

      {body}

      <ConfirmDialog
        open={removeOpen}
        title="Remove device"
        tone="destructive"
        confirmLabel="Remove"
        description={
          removing && (
            <>
              {removing.owner_name}'s device {removing.name}, in {removing.workspace_name}, stops running agents and
              can't reconnect to Switch.{" "}
              {removing.agents_total === 0
                ? "No agents are placed on it."
                : removing.agents_total === 1
                  ? "The agent on it stops, and runs again once it's put on another device."
                  : `The ${removing.agents_total} agents on it stop, and run again once they're put on another device.`}{" "}
              This can't be undone.
            </>
          )
        }
        onClose={() => setRemoveOpen(false)}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await removeOrganizationDevice(removing.workspace_id, removing.id);
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
          `Stop managing ${unmanaging.display_name ?? unmanaging.name}, in ${unmanaging.workspace_name}? ${
            unmanaging.controller_name ? `It stops running on ${unmanaging.controller_name}. ` : ""
          }The agent itself stays, with its rooms, and can be managed again later.`
        }
        onClose={() => setUnmanageOpen(false)}
        onConfirm={async () => {
          if (!unmanaging) return;
          try {
            await unmanageOrganizationAgent(unmanaging.workspace_id, unmanaging.agent_id);
          } finally {
            void load();
          }
          setNotice({ severity: "success", text: `Stopped managing ${unmanaging.display_name ?? unmanaging.name}.` });
        }}
      />
    </Box>
  );
}
