import AddCircleOutline from "@mui/icons-material/AddCircleOutline";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import EditOutlined from "@mui/icons-material/EditOutlined";
import SmartToyOutlined from "@mui/icons-material/SmartToyOutlined";
import SwapHoriz from "@mui/icons-material/SwapHoriz";
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Link,
  Stack,
  Typography,
} from "@mui/material";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router";
import ConfirmDialog from "../../components/ConfirmDialog";
import DataTable, {
  type FilterOption,
  type SelectFilter,
  type TableColumn,
  TableEmptyState,
} from "../../components/DataTable";
import PageBanner from "../../components/PageBanner";
import RowActionsMenu, { type RowAction } from "../../components/RowActionsMenu";
import { TransferOwnershipDialog } from "../../components/TransferOwnershipSection";
import { useAuth } from "../../data/AuthContext";
import {
  type AgentDevice,
  type AgentListEntry,
  type DeleteAgentResult,
  deleteAgent,
  loadAgents,
} from "../../data/api";
import { AGENT_MANAGEMENT } from "../../data/featureFlags";
import { type ListScope, agentsInScope, listScopeOf } from "../../data/listScope";
import { EM_DASH, formatDate, sentenceCase } from "../../theme/format";
import { useLoad } from "../workspace/useLoad";
import RegisterAgentDialog from "./RegisterAgentDialog";
import RenameAgentDialog from "./RenameAgentDialog";

/** Filter values for an agent with no parent, owner or device. None can be
 * an id, which these columns otherwise hold. */
const TOP_LEVEL = "top-level";
const NO_OWNER = "no-owner";
const NO_DEVICE = "no-device";

const STATUS: Record<AgentListEntry["status"], { label: string; color: string; detail?: string }> = {
  online: { label: "Online", color: "var(--sw-success)" },
  offline: { label: "Offline", color: "var(--sw-muted-foreground)" },
  not_tracked: {
    label: "Not tracked",
    color: "var(--sw-muted-foreground)",
    detail: "This agent only polls, so Switch can't see it between polls.",
  },
};

const STATUS_OPTIONS: FilterOption[] = (["online", "offline", "not_tracked"] as const).map((value) => ({
  value,
  label: STATUS[value].label,
}));

/** Kept stable: a fresh array each render would rebuild the grid's columns. */
const PINNED = ["actions"];

/** The table's header and footer, and a row, in pixels; a page of rows. */
const TABLE_CHROME = 108;
const ROW = 52;
const PAGE_SIZE = 25;

/** A category, not a status: the muted fill, so it doesn't compete with the
 *  status column for colour. */
const NEUTRAL_CHIP_SX = { backgroundColor: "var(--sw-muted)", color: "var(--sw-foreground)" };

interface Notice {
  severity: "success" | "warning" | "error";
  lines: string[];
}

/** Each device's label in this list. Every Switch Cloud device has the same
 * name, as two people's laptops may, so a name shared by several devices
 * carries its owner too. */
export function deviceLabels(agents: readonly AgentListEntry[]): Map<string, string> {
  const devices = new Map<string, AgentDevice>();
  for (const agent of agents) {
    if (agent.device) devices.set(agent.device.id, agent.device);
  }
  const named = new Map<string, number>();
  for (const { name } of devices.values()) named.set(name, (named.get(name) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const [id, { name, owner_name, removed }] of devices) {
    const shared = (named.get(name) ?? 0) > 1;
    labels.set(id, `${shared ? `${name} · ${owner_name}` : name}${removed ? " (removed)" : ""}`);
  }
  return labels;
}

const byLabel = (a: FilterOption, b: FilterOption) => a.label.localeCompare(b.label);

function StatusCell({ status }: { status: AgentListEntry["status"] }) {
  const meta = STATUS[status];
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center", height: "100%" }} title={meta.detail}>
      <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: meta.color, flexShrink: 0 }} />
      <span>{meta.label}</span>
    </Stack>
  );
}

/** The workspace's agents, or a member's own, as the design's register:
 * read and filtered here, opened for everything else. */
export default function AgentListPage() {
  const { session, capabilities } = useAuth();
  const tenant = session?.tenant;
  if (!session || !tenant) return <CircularProgress />;

  const scope = listScopeOf(capabilities);
  return (
    <AgentList
      // A change of role changes what the list holds; start it again.
      key={scope}
      scope={scope}
      userId={session.user.id}
      workspace={tenant.name}
      showDevices={capabilities.features[AGENT_MANAGEMENT]}
    />
  );
}

function AgentList({
  scope,
  userId,
  workspace,
  showDevices,
}: {
  scope: ListScope;
  userId: string;
  workspace: string;
  showDevices: boolean;
}) {
  const navigate = useNavigate();
  const { data, error, loading, refetch } = useLoad(loadAgents);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [renaming, setRenaming] = useState<AgentListEntry | null>(null);
  const [transferring, setTransferring] = useState<AgentListEntry | null>(null);
  // What the delete dialog shows, taken when it opens and kept after it
  // closes: the dialog fades out with the words it had, while the list
  // refreshes under it. `deleteOpen` alone opens and closes it.
  const [deleting, setDeleting] = useState<{ agent: AgentListEntry; subAgents: number } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const yours = scope === "yours";

  const all = useMemo(() => data ?? [], [data]);
  const rows = useMemo(() => [...agentsInScope(all, scope, userId)], [all, scope, userId]);
  // From every agent, not only the rows: a member's sub-agent may sit under
  // someone else's agent, whose name still belongs in its Parent column.
  const nameById = useMemo(() => new Map(all.map((agent) => [agent.id, agent.name])), [all]);
  const devices = useMemo(() => deviceLabels(rows), [rows]);

  const actionsFor = useCallback((agent: AgentListEntry): RowAction[] => {
    const actions: RowAction[] = [];
    if (agent.can_rename) {
      actions.push({ label: "Rename", icon: <EditOutlined fontSize="small" />, onClick: () => setRenaming(agent) });
    }
    if (agent.can_transfer || agent.transfer_blocked_reason !== null) {
      actions.push({
        label: "Transfer ownership",
        icon: <SwapHoriz fontSize="small" />,
        onClick: () => setTransferring(agent),
        disabledReason: agent.can_transfer ? null : agent.transfer_blocked_reason,
      });
    }
    if (agent.can_manage) {
      actions.push({
        label: "Delete",
        icon: <DeleteOutline fontSize="small" />,
        destructive: true,
        onClick: () => {
          setDeleting({ agent, subAgents: all.filter((other) => other.parent_agent_id === agent.id).length });
          setDeleteOpen(true);
        },
      });
    }
    return actions;
  }, [all]);

  const columns = useMemo<TableColumn<AgentListEntry>[]>(() => {
    const parents: FilterOption[] = [
      ...(rows.some((agent) => !agent.parent_agent_id) ? [{ value: TOP_LEVEL, label: "Top level" }] : []),
      ...[...new Set(rows.flatMap((agent) => (agent.parent_agent_id ? [agent.parent_agent_id] : [])))]
        .map((id) => ({ value: id, label: nameById.get(id) ?? id }))
        .sort(byLabel),
    ];
    const owners: FilterOption[] = [
      ...[...new Map(rows.flatMap((agent) => (agent.owner_id ? [[agent.owner_id, agent.owner_name ?? agent.owner_id]] : []))).entries()]
        .map(([value, label]) => ({ value, label }))
        .sort(byLabel),
      ...(rows.some((agent) => !agent.owner_id) ? [{ value: NO_OWNER, label: "No owner" }] : []),
    ];
    const deviceOptions: FilterOption[] = [
      ...[...devices.entries()].map(([value, label]) => ({ value, label })).sort(byLabel),
      ...(rows.some((agent) => !agent.device) ? [{ value: NO_DEVICE, label: "No device" }] : []),
    ];

    return [
      {
        field: "name",
        headerName: "Name",
        flex: 1,
        minWidth: 160,
        renderCell: ({ row, tabIndex }) => (
          <Link
            component={RouterLink}
            to={`/agents/${row.id}`}
            tabIndex={tabIndex}
            // The row opens the agent too; one navigation, not two.
            onClick={(event) => event.stopPropagation()}
            underline="hover"
            sx={{ fontWeight: 500, color: "text.primary" }}
          >
            {row.name}
          </Link>
        ),
      },
      {
        field: "connector_type",
        headerName: "Agent type",
        width: 124,
        filter: { value: (agent) => agent.connector_type },
        renderCell: ({ value }) => <Chip label={value} size="small" variant="outlined" />,
      },
      {
        field: "connection_model",
        headerName: "Availability",
        width: 180,
        renderCell: ({ value }) =>
          value ? <Chip label={sentenceCase(value as string)} size="small" sx={NEUTRAL_CHIP_SX} /> : EM_DASH,
      },
      {
        field: "status",
        headerName: "Status",
        width: 120,
        filter: { value: (agent) => agent.status, options: STATUS_OPTIONS },
        renderCell: ({ row }) => <StatusCell status={row.status} />,
      },
      {
        field: "parent_agent_id",
        headerName: "Parent",
        width: 140,
        filter: { value: (agent) => agent.parent_agent_id ?? TOP_LEVEL, options: parents },
        valueGetter: (value) => (value ? (nameById.get(value as string) ?? value) : ""),
        renderCell: ({ value }) => value || EM_DASH,
      },
      {
        field: "description",
        headerName: "Description",
        flex: 2,
        minWidth: 125,
        sortable: false,
        renderCell: ({ value }) => (
          <Box
            component="span"
            title={value}
            sx={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", color: "text.secondary" }}
          >
            {value}
          </Box>
        ),
      },
      { field: "tool_count", headerName: "Tools", width: 64, type: "number" },
      { field: "model_count", headerName: "Models", width: 72, type: "number" },
      {
        field: "owner_name",
        headerName: "Owner",
        width: 140,
        ...(!yours && { filter: { value: (agent: AgentListEntry) => agent.owner_id ?? NO_OWNER, options: owners } }),
        renderCell: ({ value }) => value ?? EM_DASH,
      },
      ...(showDevices
        ? [
            {
              field: "device",
              headerName: "Device",
              width: 150,
              sortable: false,
              filter: {
                value: (agent: AgentListEntry) => agent.device?.id ?? NO_DEVICE,
                options: deviceOptions,
              },
              renderCell: ({ row }: { row: AgentListEntry }) => {
                if (!row.device) return EM_DASH;
                const label = devices.get(row.device.id) ?? row.device.name;
                return <span title={label}>{label}</span>;
              },
            } satisfies TableColumn<AgentListEntry>,
          ]
        : []),
      {
        field: "created_at",
        headerName: "Created",
        width: 112,
        type: "date",
        valueGetter: (value) => new Date(value as string),
        valueFormatter: (value) => formatDate(value as Date),
      },
      {
        field: "actions",
        headerName: "",
        width: 56,
        sortable: false,
        disableColumnMenu: true,
        renderCell: ({ row, tabIndex }) => (
          <RowActionsMenu label={`Actions for ${row.name}`} actions={actionsFor(row)} tabIndex={tabIndex} />
        ),
      },
    ];
  }, [rows, nameById, devices, yours, showDevices, actionsFor]);

  const selectFilters = useMemo<SelectFilter[]>(
    () => [
      { field: "connector_type", label: "Type", allLabel: "All types" },
      { field: "parent_agent_id", label: "Parent", allLabel: "All parents" },
      ...(yours ? [] : [{ field: "owner_name", label: "Owner", allLabel: "All owners" }]),
      { field: "status", label: "Status", allLabel: "All statuses" },
      ...(showDevices ? [{ field: "device", label: "Device", allLabel: "All devices" }] : []),
    ],
    [yours, showDevices],
  );

  const search = useMemo(
    () => ({
      label: "Search agents",
      text: (agent: AgentListEntry) =>
        [
          agent.name,
          agent.display_name ?? "",
          agent.description,
          agent.parent_agent_id ? (nameById.get(agent.parent_agent_id) ?? "") : "",
          agent.owner_name ?? "",
        ].join(" "),
    }),
    [nameById],
  );

  const addButton = (
    <Button variant="contained" startIcon={<AddCircleOutline />} onClick={() => setRegisterOpen(true)}>
      Add agent
    </Button>
  );

  // Two different nothings: the workspace has no agents at all, or it has
  // some and none are this member's.
  const workspaceEmpty = all.length === 0;
  // With nothing to list there is nothing to filter, so the card stands in
  // for the filters and the table, as the design has it.
  const emptyCard = (
    <Card variant="outlined" sx={{ borderRadius: "16px" }}>
      <Stack spacing={2} sx={{ alignItems: "center", px: 3, py: 8 }}>
        <SmartToyOutlined aria-hidden sx={{ color: "text.secondary" }} />
        <TableEmptyState
          title={workspaceEmpty ? `No agents in ${workspace} yet` : `You don't own any agents in ${workspace}`}
        >
          {workspaceEmpty
            ? "Add an agent to let it join rooms and work alongside the people in this workspace."
            : "Add an agent of your own, or ask a workspace admin to transfer one to you."}
        </TableEmptyState>
        {addButton}
      </Stack>
    </Card>
  );

  let body: ReactNode;
  if (data === null && loading) {
    body = <CircularProgress aria-label="Loading agents" />;
  } else if (data === null) {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void refetch()}>
            Retry
          </Button>
        }
      >
        Couldn't load the agents: {error}
      </Alert>
    );
  } else if (rows.length === 0) {
    body = emptyCard;
  } else {
    body = (
      <DataTable
        rows={rows}
        columns={columns}
        // Sized to a page of rows, as the design's table is: the page
        // scrolls, not the table, and a short list ends at its last row.
        height={TABLE_CHROME + ROW * Math.min(rows.length, PAGE_SIZE)}
        pageSize={PAGE_SIZE}
        noun={{ one: "agent", other: "agents" }}
        search={search}
        selectFilters={selectFilters}
        initialSort={{ field: "created_at", sort: "desc" }}
        pinnedRight={PINNED}
        onRowClick={(params) => navigate(`/agents/${params.id}`)}
        sx={{ "& .MuiDataGrid-row": { cursor: "pointer" } }}
      />
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start", justifyContent: "space-between", mb: 3 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h5">Agents</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {yours ? `The agents you own in ${workspace}.` : `Agents in ${workspace}.`}
          </Typography>
        </Box>
        {addButton}
      </Stack>

      {data !== null && error !== null && (
        <Box sx={{ mb: 2 }}>
          <PageBanner
            tone="warning"
            action={
              <Button color="inherit" size="small" onClick={() => void refetch()}>
                Retry
              </Button>
            }
          >
            Couldn't refresh the agents: {error}. This is the list as last loaded.
          </PageBanner>
        </Box>
      )}

      {notice && (
        <Alert severity={notice.severity} onClose={() => setNotice(null)} sx={{ mb: 2 }}>
          {notice.lines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </Alert>
      )}

      {body}

      <RegisterAgentDialog open={registerOpen} onClose={() => setRegisterOpen(false)} onRegistered={refetch} />

      {renaming && (
        <RenameAgentDialog
          open
          agent={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={(lines, severity) => {
            setRenaming(null);
            setNotice({ severity, lines });
            void refetch();
          }}
        />
      )}

      {transferring && (
        <TransferOwnershipDialog
          kind="agent"
          resourceId={transferring.id}
          resourceLabel={transferring.name}
          ownerId={transferring.owner_id}
          onClose={() => setTransferring(null)}
          onTransferred={() => {
            setNotice({
              severity: "success",
              lines: [
                yours
                  ? `Transferred "${transferring.name}". It's no longer yours, so it has left this list.`
                  : `Transferred "${transferring.name}".`,
              ],
            });
            setTransferring(null);
            void refetch();
          }}
        />
      )}

      <ConfirmDialog
        open={deleteOpen}
        title="Delete agent"
        tone="destructive"
        confirmLabel="Delete"
        description={
          deleting && (
            <>
              Delete "{deleting.agent.name}"? Its client stops, and its tools and models are removed.
              {deleting.subAgents > 0 &&
                (deleting.subAgents === 1
                  ? " Its sub-agent stays, as a top-level agent."
                  : ` Its ${deleting.subAgents} sub-agents stay, as top-level agents.`)}
            </>
          )
        }
        onClose={() => setDeleteOpen(false)}
        onConfirm={async () => {
          if (!deleting) return;
          const { agent } = deleting;
          let result: DeleteAgentResult;
          try {
            result = await deleteAgent(agent.id);
          } catch (err) {
            // The refusal may be that it is already gone, deleted elsewhere:
            // the list catches up while the dialog says why.
            void refetch();
            throw err;
          }
          setNotice(
            result.bridge_cleanup_failures.length > 0
              ? {
                  severity: "warning",
                  lines: [
                    `Deleted "${agent.name}", but its chat platform clean-up did not finish ` +
                      `(${result.bridge_cleanup_failures.join("; ")}). It finishes when that bridge next starts.`,
                  ],
                }
              : { severity: "success", lines: [`Deleted "${agent.name}".`] },
          );
          void refetch();
        }}
      />
    </Box>
  );
}
