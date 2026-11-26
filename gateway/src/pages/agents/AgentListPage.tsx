import "@switch-console/chat-ui/theme.css";
import { AddAgentTile, AgentCard, AgentCardGrid } from "@switch-console/chat-ui/components/agent-cards";
import { ServerPage } from "@switch-console/chat-ui/components/server-page";
import { SHARED_UI_CLASS } from "@switch-console/chat-ui/model/scope";
import { Alert, AlertAction, AlertDescription } from "@switch-console/chat-ui/primitives/alert";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@switch-console/chat-ui/primitives/dropdown-menu";
import { SearchInput } from "@switch-console/chat-ui/primitives/search-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@switch-console/chat-ui/primitives/select";
import { Spinner } from "@switch-console/chat-ui/primitives/spinner";
import { ArrowRightLeft, Pencil, Trash2, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import AgentPicture from "../../components/AgentPicture";
import ConfirmDialog from "../../components/ConfirmDialog";
import SuccessSnackbar from "../../components/SuccessSnackbar";
import { TransferOwnershipDialog } from "../../components/TransferOwnershipSection";
import { agentPath } from "../../data/agentPaths";
import { useAuth } from "../../data/AuthContext";
import type { Capabilities } from "../../data/capabilities";
import {
  type AgentDevice,
  type AgentListEntry,
  type DeleteAgentResult,
  deleteAgent,
  fetchAvatarSettings,
  loadAgents,
} from "../../data/api";
import { AGENT_MANAGEMENT } from "../../data/featureFlags";
import { type ListScope, agentsInScope, listScopeOf } from "../../data/listScope";
import { useLoad } from "../workspace/useLoad";
import { NewAgentDialog } from "./NewAgentDialog";
import RegisterAgentDialog from "./RegisterAgentDialog";
import RenameAgentDialog from "./RenameAgentDialog";

/** Filter values for an agent with no parent, owner or device. None can be
 * an id, which these filters otherwise hold. */
const TOP_LEVEL = "top-level";
const NO_OWNER = "no-owner";
const NO_DEVICE = "no-device";
/** The value of a filter that lets every agent through. */
const ALL = "all";

const STATUS: Record<AgentListEntry["status"], { label: string; dot: string; detail?: string }> = {
  online: { label: "Online", dot: "bg-foreground-success" },
  offline: { label: "Offline", dot: "bg-foreground-muted" },
  not_tracked: {
    label: "Not tracked",
    dot: "bg-foreground-muted",
    detail: "This agent only polls, so Switch can't see it between polls.",
  },
};

const STATUSES = ["online", "offline", "not_tracked"] as const;

type FilterField = "type" | "parent" | "owner" | "status" | "device";

interface FilterOption {
  value: string;
  label: string;
}

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

/** What each filter reads off an agent. */
const FILTER_VALUE: Record<FilterField, (agent: AgentListEntry) => string> = {
  type: (agent) => agent.connector_type,
  parent: (agent) => agent.parent_agent_id ?? TOP_LEVEL,
  owner: (agent) => agent.owner_id ?? NO_OWNER,
  status: (agent) => agent.status,
  device: (agent) => agent.device?.id ?? NO_DEVICE,
};

const FILTER_LABEL: Record<FilterField, { label: string; all: string }> = {
  type: { label: "Type", all: "All types" },
  parent: { label: "Parent", all: "All parents" },
  owner: { label: "Owner", all: "All owners" },
  status: { label: "Status", all: "All statuses" },
  device: { label: "Device", all: "All devices" },
};

function FilterSelect({
  field,
  options,
  value,
  onChange,
}: {
  field: FilterField;
  options: FilterOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { label, all } = FILTER_LABEL[field];
  return (
    <Select value={value} onValueChange={(next) => onChange(next as string)}>
      <SelectTrigger aria-label={label} className="h-9">
        <SelectValue>{value === ALL ? all : (options.find((o) => o.value === value)?.label ?? value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{all}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The workspace's agents, or a member's own, as cards in Console's design:
 * read and filtered here, opened for everything else. */
export default function AgentListPage() {
  const { session, capabilities } = useAuth();
  const tenant = session?.tenant;
  if (!session || !tenant) return <Spinner />;

  const scope = listScopeOf(capabilities);
  return (
    <AgentList
      // A change of role changes what the list holds; start it again.
      key={scope}
      scope={scope}
      userId={session.user.id}
      workspace={tenant.name}
      showDevices={capabilities.features[AGENT_MANAGEMENT]}
      capabilities={capabilities}
    />
  );
}

function AgentList({
  scope,
  userId,
  workspace,
  showDevices,
  capabilities,
}: {
  scope: ListScope;
  userId: string;
  workspace: string;
  showDevices: boolean;
  capabilities: Capabilities;
}) {
  const navigate = useNavigate();
  const { data, error, loading, refetch } = useLoad(loadAgents);
  const avatars = useLoad(fetchAvatarSettings);
  const [newOpen, setNewOpen] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  // Switch runs a new agent on one of the person's devices where it manages
  // agents; elsewhere the only way to add one is to connect an agent that runs
  // on its own, which an admin can also do from the New agent dialog.
  const managed = capabilities.features[AGENT_MANAGEMENT];
  const [renaming, setRenaming] = useState<AgentListEntry | null>(null);
  const [transferring, setTransferring] = useState<AgentListEntry | null>(null);
  // What the delete dialog shows, taken when it opens and kept after it
  // closes: the dialog fades out with the words it had, while the list
  // refreshes under it. `deleteOpen` alone opens and closes it.
  const [deleting, setDeleting] = useState<{ agent: AgentListEntry; subAgents: number } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<FilterField, string>>({
    type: ALL,
    parent: ALL,
    owner: ALL,
    status: ALL,
    device: ALL,
  });
  const yours = scope === "yours";

  const all = useMemo(() => data ?? [], [data]);
  const rows = useMemo(() => [...agentsInScope(all, scope, userId)], [all, scope, userId]);
  // From every agent, not only the rows: a member's sub-agent may sit under
  // someone else's agent, whose name still belongs on its card.
  const nameById = useMemo(() => new Map(all.map((agent) => [agent.id, agent.name])), [all]);
  const devices = useMemo(() => deviceLabels(rows), [rows]);

  const options = useMemo<Partial<Record<FilterField, FilterOption[]>>>(() => {
    const types = [...new Set(rows.map((agent) => agent.connector_type))]
      .map((value) => ({ value, label: value }))
      .sort(byLabel);
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
    // Only the statuses some agent here has, so none returns nothing.
    const statuses: FilterOption[] = STATUSES.filter((status) => rows.some((agent) => agent.status === status)).map(
      (value) => ({ value, label: STATUS[value].label }),
    );
    return {
      type: types,
      parent: parents,
      ...(yours ? {} : { owner: owners }),
      status: statuses,
      ...(showDevices ? { device: deviceOptions } : {}),
    };
  }, [rows, nameById, devices, yours, showDevices]);

  const needle = query.trim().toLocaleLowerCase();
  const shown = rows
    .filter((agent) =>
      (Object.keys(options) as FilterField[]).every(
        (field) => filters[field] === ALL || FILTER_VALUE[field](agent) === filters[field],
      ),
    )
    .filter(
      (agent) =>
        needle === "" ||
        [
          agent.name,
          agent.display_name ?? "",
          agent.description,
          agent.parent_agent_id ? (nameById.get(agent.parent_agent_id) ?? "") : "",
          agent.owner_name ?? "",
        ]
          .join("\n")
          .toLocaleLowerCase()
          .includes(needle),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const filtering = needle !== "" || Object.values(filters).some((value) => value !== ALL);

  const actionsFor = (agent: AgentListEntry): ReactNode => {
    const items: ReactNode[] = [];
    if (agent.can_rename) {
      items.push(
        <DropdownMenuItem key="rename" onClick={() => setRenaming(agent)}>
          <Pencil className="size-4" />
          Rename…
        </DropdownMenuItem>,
      );
    }
    if (agent.can_transfer || agent.transfer_blocked_reason !== null) {
      items.push(
        <DropdownMenuItem key="transfer" disabled={!agent.can_transfer} onClick={() => setTransferring(agent)}>
          <ArrowRightLeft className="size-4" />
          <span className="flex flex-col">
            Transfer ownership…
            {!agent.can_transfer && (
              <span className="text-xs text-foreground-muted">{agent.transfer_blocked_reason}</span>
            )}
          </span>
        </DropdownMenuItem>,
      );
    }
    if (agent.can_manage) {
      if (items.length > 0) items.push(<DropdownMenuSeparator key="separator" />);
      items.push(
        <DropdownMenuItem
          key="delete"
          variant="destructive"
          onClick={() => {
            setDeleting({ agent, subAgents: all.filter((other) => other.parent_agent_id === agent.id).length });
            setDeleteOpen(true);
          }}
        >
          <Trash2 className="size-4" />
          Delete agent…
        </DropdownMenuItem>,
      );
    }
    return items.length > 0 ? items : null;
  };

  const card = (agent: AgentListEntry) => {
    const label = agent.display_name ?? agent.name;
    const status = STATUS[agent.status];
    const device = showDevices && agent.device ? (devices.get(agent.device.id) ?? agent.device.name) : null;
    const owner = agent.owner_name ?? (agent.owner_id ? "an unknown owner" : null);
    const parent = agent.parent_agent_id ? (nameById.get(agent.parent_agent_id) ?? agent.parent_agent_id) : null;
    const note = [
      parent && `under ${parent}`,
      !yours && (owner ? `by ${owner}` : "No owner"),
    ].filter(Boolean).join(" · ");
    return (
      <AgentCard
        key={agent.id}
        label={label}
        avatar={
          <AgentPicture
            name={label}
            iconUrl={agent.icon_url ?? null}
            size={66}
            thirdParty={avatars.data?.third_party_avatars_enabled ?? null}
          />
        }
        detail={device ? `${agent.connector_type} · ${device}` : agent.connector_type}
        note={note || null}
        footer={
          <div className="relative self-start px-3.5 pb-3">
            <span title={status.detail} className="flex items-center gap-1.5 text-xs text-foreground-muted">
              <span aria-hidden className={`size-2 shrink-0 rounded-full ${status.dot}`} />
              {status.label}
            </span>
          </div>
        }
        actions={actionsFor(agent)}
        onOpen={() => navigate(agentPath(agent.id, capabilities))}
      />
    );
  };

  let body: ReactNode;
  if (data === null && loading) {
    body = (
      <div className="flex justify-center py-12">
        <Spinner aria-label="Loading agents" />
      </div>
    );
  } else if (data === null) {
    body = (
      <Alert variant="destructive">
        <AlertDescription>Couldn't load the agents: {error}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="xs" onClick={() => void refetch()}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  } else {
    body = (
      <>
        {rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              containerClassName="min-w-60 flex-1"
              className="h-9"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter agents by name…"
              aria-label="Search agents"
            />
            {(Object.keys(options) as FilterField[]).map((field) => (
              <FilterSelect
                key={field}
                field={field}
                options={options[field] ?? []}
                value={filters[field]}
                onChange={(value) => setFilters((current) => ({ ...current, [field]: value }))}
              />
            ))}
          </div>
        )}
        {filtering && shown.length === 0 && (
          <p className="py-2 text-sm text-foreground-muted">
            {yours ? "None of your agents match these filters." : "No agent here matches these filters."}
          </p>
        )}
        <AgentCardGrid>
          <AddAgentTile onClick={() => (managed ? setNewOpen(true) : setRegisterOpen(true))} />
          {shown.map(card)}
        </AgentCardGrid>
      </>
    );
  }

  return (
    <div className={`${SHARED_UI_CLASS} flex min-h-0 flex-1 flex-col`}>
    <ServerPage
      width={880}
      title="Agents"
      term="agent"
      description={yours ? `The agents you own in ${workspace}.` : `Agents in ${workspace}.`}
    >
      {data !== null && error !== null && (
        <Alert variant="warning">
          <AlertDescription>Couldn't refresh the agents: {error}. This is the list as last loaded.</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="xs" onClick={() => void refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}

      {notice && notice.severity !== "success" && (
        <Alert variant={notice.severity === "error" ? "destructive" : "warning"}>
          <AlertDescription>
            {notice.lines.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </AlertDescription>
          <AlertAction>
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => setNotice(null)}>
              <X className="size-3.5" />
            </Button>
          </AlertAction>
        </Alert>
      )}

      {body}

      <NewAgentDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onAddOutsideAgent={capabilities.administersWorkspace ? () => setRegisterOpen(true) : null}
      />
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

      <SuccessSnackbar
        message={notice?.severity === "success" ? notice.lines.join(" ") : null}
        onClose={() => setNotice(null)}
      />
    </ServerPage>
    </div>
  );
}
