import AddCircleOutline from "@mui/icons-material/AddCircleOutline";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import SearchIcon from "@mui/icons-material/Search";
import {
  Alert,
  Autocomplete,
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
  InputAdornment,
  Link,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import DataTable from "../../components/DataTable";
import { type AgentSummary, deleteAgent } from "../../data/api";
import { useAgents, useHostedV2 } from "../../data/hooks";
import { useCloudView } from "../../data/hostedCloud";
import { EM_DASH, formatDate, sentenceCase } from "../../theme/hootFormat";
import { type CloudPresentation, cloudStatusFor } from "./cloud/cloudAgentState";
import { boxShowsStopped } from "./cloud/yourCloud";
import { AI_LOGINS_ID } from "./cloud/ids";
import { type LoginTick, type NextAction, agentProvider } from "./cloud/peopleWords";
import StateFade from "./cloud/StateFade";
import RegisterAgentDialog from "./RegisterAgentDialog";

// Hosted agents v2's parts of this page load on first use, only with v2 on, so
// a v1 visitor downloads none of them.
const CloudDeleteDialog = lazy(() => import("./cloud/CloudDeleteDialog"));
const CloudLoginsSection = lazy(() => import("./cloud/CloudLoginsSection"));
const YourCloudPanel = lazy(() => import("./cloud/YourCloudPanel"));
const CloudAgentDialog = lazy(() => import("./CloudAgentDialog"));

// Connector type is a category, not a status. Colour here would compete with
// the status hues for the reader's attention and mean nothing, so the tag is
// neutral and the label carries the distinction.

/** Read by screen readers, not shown (as MUI's `visuallyHidden`, which is not a direct dependency here). */
const visuallyHidden = {
  border: 0,
  clip: "rect(0 0 0 0)",
  height: "1px",
  margin: "-1px",
  overflow: "hidden",
  padding: 0,
  position: "absolute",
  whiteSpace: "nowrap",
  width: "1px",
} as const;

export default function AgentsPage() {
  const navigate = useNavigate();
  const { data: agents, loading, refetch } = useAgents();
  // Hosted agents v2 only: with it off (or still loading) nothing below is
  // read and neither the panel nor the Cloud column exists.
  const hostedV2 = useHostedV2() === true;
  const cloud = useCloudView(hostedV2);
  const [deleteTarget, setDeleteTarget] = useState<AgentSummary | null>(null);
  // A cloud agent's delete takes its login into account (`CloudDeleteDialog`).
  const [cloudDeleteTarget, setCloudDeleteTarget] = useState<AgentSummary | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<{
    severity: "warning" | "error";
    text: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  // Add agent on Switch cloud: where this workspace may have a box, from the
  // same read as the panel (`available`).
  const [cloudOpen, setCloudOpen] = useState(false);
  const cloudAgents = hostedV2 && cloud.available;
  // "AI login set", from the logins section (`loginTick`); a box with no
  // controller yet can't have a login. While the agents list is still
  // loading it waits rather than tick on "any login" (as Console does); if
  // the list can't be read, any ready login counts.
  const [loginRead, setLoginRead] = useState<LoginTick | null>(null);
  const loginSet = !cloud.machine?.controller_id
    ? false
    : loading && !agents
      ? null
      : (loginRead?.set ?? null);
  // The provider each of the box's agents runs, from the agents list already read.
  const agentProviders = useMemo(() => {
    const byId = new Map((agents ?? []).map((agent) => [agent.id, agent]));
    return (cloud.machine?.agents ?? []).map((id) => agentProvider(byId.get(id)?.known_agent_type));
  }, [agents, cloud.machine?.agents]);
  // The checklist's Give login opens the first missing provider's form.
  const [askLogin, setAskLogin] = useState<{ provider: string } | null>(null);
  const [ownerFilter, setOwnerFilter] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  // "" = all, "__top__" = top-level only, "__sub__" = subagents only,
  // otherwise a specific parent agent id.
  const [parentFilter, setParentFilter] = useState<string>("");

  const ownerNames = useMemo(() => {
    const names = new Set<string>();
    for (const agent of agents ?? []) {
      if (agent.owner_name) names.add(agent.owner_name);
    }
    return [...names].sort();
  }, [agents]);

  const typeNames = useMemo(() => {
    const names = new Set<string>();
    for (const agent of agents ?? []) {
      if (agent.connector_type) names.add(agent.connector_type);
    }
    return [...names].sort();
  }, [agents]);

  // Resolve parent_agent_id → name for the Parent column. Built from the full
  // agent list (not the filtered view) so a child's parent still resolves when
  // an owner filter would otherwise hide the parent.
  const parentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  // Agents that are themselves a parent of at least one subagent — the only
  // ids worth offering as a specific "Parent" filter value.
  const parentAgents = useMemo(() => {
    const ids = new Set<string>();
    for (const agent of agents ?? []) {
      if (agent.parent_agent_id) ids.add(agent.parent_agent_id);
    }
    return [...ids]
      .map((id) => ({ id, name: parentNameById.get(id) ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [agents, parentNameById]);

  // Options for the Parent filter Autocomplete: two pinned structural choices,
  // then a searchable, grouped list of every agent that has children. Using an
  // Autocomplete (not a Select) keeps this usable as the parent count grows.
  const parentOptions = useMemo(
    () => [
      { value: "__top__", label: "Top-level only", group: "Hierarchy" },
      { value: "__sub__", label: "Subagents only", group: "Hierarchy" },
      ...parentAgents.map((p) => ({
        value: p.id,
        label: p.name,
        group: "By parent",
      })),
    ],
    [parentAgents],
  );

  const filteredAgents = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (agents ?? []).filter((a) => {
      if (ownerFilter && a.owner_name !== ownerFilter) return false;
      if (typeFilter && a.connector_type !== typeFilter) return false;
      if (parentFilter === "__top__" && a.parent_agent_id) return false;
      if (parentFilter === "__sub__" && !a.parent_agent_id) return false;
      if (
        parentFilter &&
        parentFilter !== "__top__" &&
        parentFilter !== "__sub__" &&
        a.parent_agent_id !== parentFilter
      )
        return false;
      if (
        q &&
        !a.name.toLowerCase().includes(q) &&
        !a.description.toLowerCase().includes(q) &&
        !(hostedV2 && a.display_name?.toLowerCase().includes(q))
      )
        return false;
      return true;
    });
  }, [agents, ownerFilter, typeFilter, parentFilter, search, hostedV2]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const result = await deleteAgent(deleteTarget.id);
    if (result === null) {
      setDeleteNotice({
        severity: "error",
        text: `Could not delete agent "${deleteTarget.name}".`,
      });
    } else if (result.bridge_cleanup_failures.length > 0) {
      setDeleteNotice({
        severity: "warning",
        text:
          `Deleted "${deleteTarget.name}", but its chat platform clean-up did not ` +
          `finish (${result.bridge_cleanup_failures.join("; ")}). It will be ` +
          "finished when that bridge next starts.",
      });
    } else {
      setDeleteNotice(null);
    }
    setDeleteTarget(null);
    setDeleting(false);
    refetch();
  }, [deleteTarget, refetch]);

  // A next step's link: bring its section into view and move focus there, so
  // keyboard and screen-reader users land on it too.
  const goToStep = useCallback((step: NextAction) => {
    const section = step === "give_login" ? document.getElementById(AI_LOGINS_ID) : null;
    section?.scrollIntoView?.({ block: "center" });
    section?.focus();
  }, []);

  // Each agent's state on the person's cloud; worked out once per read.
  const cloudStatus = useMemo(() => {
    const onBox = new Set(cloud.machine?.agents ?? []);
    const boxStopped = cloud.machine !== null && boxShowsStopped(cloud.machine);
    const now = new Date();
    const map = new Map<string, CloudPresentation>();
    for (const agent of agents ?? []) {
      const shown = cloudStatusFor(agent.id, cloud.agents, onBox, now, boxStopped);
      if (shown) map.set(agent.id, shown);
    }
    return map;
  }, [agents, cloud.agents, cloud.machine]);

  const columns = useMemo<GridColDef<AgentSummary>[]>(
    () => [
      {
        field: "name",
        headerName: "Name",
        flex: 1,
        minWidth: 200,
        // With hosted agents v2 on, the label people read, as Console shows it:
        // renaming a cloud agent changes only its display name (PM review).
        // With it off, the column is as upstream.
        ...(hostedV2
          ? {
              valueGetter: (_value: unknown, row: AgentSummary) =>
                row.display_name || row.name,
            }
          : {}),
      },
      ...(hostedV2
        ? [
            {
              field: "cloud_status",
              headerName: "Cloud",
              width: 220,
              sortable: false,
              valueGetter: (_value: unknown, row: AgentSummary) =>
                cloudStatus.get(row.id)?.label ?? "",
              renderCell: ({ row }: { row: AgentSummary }) => {
                const shown = cloudStatus.get(row.id);
                if (!shown)
                  return (
                    <Box component="span" sx={{ color: "text.secondary" }}>
                      {EM_DASH}
                    </Box>
                  );
                // Two short lines rather than one cut off ("Back in a moment · Startin…"):
                // the state, then its detail. Each line still ends in "…" if a very
                // narrow column needs it, with the whole line on hover, and the hidden
                // " · " keeps it one sentence for screen readers.
                const full = [shown.label, shown.detail].filter(Boolean).join(" · ");
                const hover = shown.when ? `${full} (${shown.when})` : full;
                const line = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;
                return (
                  <Box
                    title={hover}
                    data-testid="cloud-cell"
                    sx={{ display: "flex", flexDirection: "column", justifyContent: "center", height: "100%", minWidth: 0, lineHeight: 1.3 }}
                  >
                    <StateFade state={`${shown.label}|${shown.detail ?? ""}`} component="div">
                      <Box sx={line}>{shown.label}</Box>
                      {shown.detail && (
                        <Box sx={{ ...line, typography: "caption" }}>
                          <Box component="span" sx={visuallyHidden}>
                            {" · "}
                          </Box>
                          {shown.next ? (
                            // The second part is the next step: it goes there.
                            <Link
                              component="button"
                              variant="caption"
                              sx={{ verticalAlign: "baseline" }}
                              onClick={(event) => {
                                // The row opens the agent; this link only goes to the step.
                                event.stopPropagation();
                                goToStep(shown.next!);
                              }}
                            >
                              {shown.detail}
                            </Link>
                          ) : (
                            <Box component="span" sx={{ color: "text.secondary" }}>
                              {shown.detail}
                            </Box>
                          )}
                        </Box>
                      )}
                    </StateFade>
                  </Box>
                );
              },
            } satisfies GridColDef<AgentSummary>,
          ]
        : []),
      {
        field: "connector_type",
        headerName: "Agent type",
        width: 150,
        renderCell: ({ value }) =>
          value ? (
            <Chip label={value} size="small" />
          ) : (
            <Box component="span" sx={{ color: "text.secondary" }}>
              {EM_DASH}
            </Box>
          ),
      },
      {
        field: "connection_model",
        headerName: "Availability",
        width: 170,
        valueFormatter: (value) => (value ? sentenceCase(value as string) : EM_DASH),
      },
      {
        field: "parent_agent_id",
        headerName: "Parent",
        width: 200,
        valueGetter: (value) =>
          value ? (parentNameById.get(value as string) ?? value) : "",
        renderCell: ({ value }) => value || EM_DASH,
      },
      { field: "description", headerName: "Description", flex: 2, minWidth: 200 },
      { field: "tool_count", headerName: "Tools", width: 80, type: "number" },
      { field: "model_count", headerName: "Models", width: 90, type: "number" },
      {
        field: "owner_name",
        headerName: "Owner",
        width: 130,
        renderCell: ({ value }) => value ?? EM_DASH,
      },
      {
        field: "created_at",
        headerName: "Created",
        width: 130,
        valueFormatter: (value) => formatDate(value as string),
      },
      {
        field: "actions",
        headerName: "",
        width: 100,
        sortable: false,
        filterable: false,
        renderCell: ({ row }) => {
          if (!row.can_manage) return null;
          return (
            <>
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  if (hostedV2 && cloud.machine?.controller_id && cloud.machine.agents.includes(row.id))
                    setCloudDeleteTarget(row);
                  else setDeleteTarget(row);
                }}
              >
                <DeleteOutline fontSize="small" />
              </IconButton>
            </>
          );
        },
      },
    ],
    [parentNameById, hostedV2, cloudStatus, cloud.machine, goToStep],
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}>
        <Typography variant="h5">Agents</Typography>
        {hostedV2 ? (
          <Stack direction="row" spacing={1}>
            {cloudAgents && (
              <Button
                variant="contained"
                startIcon={<AddCircleOutline />}
                onClick={() => setCloudOpen(true)}
              >
                Add agent on Switch cloud
              </Button>
            )}
            <Button
              variant={cloudAgents ? "outlined" : "contained"}
              startIcon={<AddCircleOutline />}
              onClick={() => setRegisterOpen(true)}
            >
              Add agent
            </Button>
          </Stack>
        ) : (
          // With v2 off, exactly main's header button.
          <Button
            variant="contained"
            startIcon={<AddCircleOutline />}
            onClick={() => setRegisterOpen(true)}
          >
            Add agent
          </Button>
        )}
      </Stack>

      <Suspense fallback={null}>
        {hostedV2 && cloud.machine && (
          <YourCloudPanel
            machine={cloud.machine}
            onChanged={cloud.refresh}
            loginSet={loginSet}
            onGiveLogin={() => {
              goToStep("give_login");
              if (loginRead?.missing) setAskLogin({ provider: loginRead.missing });
            }}
            onAddAgent={cloudAgents ? () => setCloudOpen(true) : undefined}
          />
        )}
      </Suspense>
      <Suspense fallback={null}>
        {hostedV2 && cloud.machine?.controller_id && (
          <CloudLoginsSection
            controllerId={cloud.machine.controller_id}
            machine={cloud.machine}
            onCloudChanged={cloud.refresh}
            onLoginSet={setLoginRead}
            onHurry={cloud.hurry}
            agentProviders={agentProviders}
            ask={askLogin}
          />
        )}
      </Suspense>

      {deleteNotice && (
        <Alert
          severity={deleteNotice.severity}
          onClose={() => setDeleteNotice(null)}
          sx={{ mb: 2 }}
        >
          {deleteNotice.text}
        </Alert>
      )}

      <Stack
        direction="row"
        spacing={2}
        sx={{ mb: 2, flexWrap: "wrap", rowGap: 2 }}
      >
        <TextField
          size="small"
          placeholder="Search agents…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ width: 280 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
        {typeNames.length > 0 && (
          <TextField
            size="small"
            select
            label="Type"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            sx={{ width: 180 }}
          >
            <MenuItem value="">All</MenuItem>
            {typeNames.map((name) => (
              <MenuItem key={name} value={name}>
                {name}
              </MenuItem>
            ))}
          </TextField>
        )}
        <Autocomplete
          size="small"
          sx={{ width: 220 }}
          options={parentOptions}
          groupBy={(o) => o.group}
          getOptionLabel={(o) => o.label}
          isOptionEqualToValue={(o, v) => o.value === v.value}
          value={parentOptions.find((o) => o.value === parentFilter) ?? null}
          onChange={(_e, v) => setParentFilter(v?.value ?? "")}
          renderInput={(params) => (
            <TextField {...params} label="Parent" placeholder="All" />
          )}
        />
        {ownerNames.length > 0 && (
          <TextField
            size="small"
            select
            label="Owner"
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
            sx={{ width: 200 }}
          >
            <MenuItem value="">All</MenuItem>
            {ownerNames.map((name) => (
              <MenuItem key={name} value={name}>
                {name}
              </MenuItem>
            ))}
          </TextField>
        )}
      </Stack>

      {loading ? (
        <CircularProgress />
      ) : (
        <DataTable
          rows={filteredAgents}
          columns={columns}
          fillHeight
          onRowClick={(params) => navigate(`/agents/${params.id}`)}
          sx={{ "& .MuiDataGrid-row": { cursor: "pointer" } }}
        />
      )}

      <Suspense fallback={null}>
        {hostedV2 && cloud.machine?.controller_id && (
          <CloudDeleteDialog
            agent={cloudDeleteTarget}
            controllerId={cloud.machine.controller_id}
            onClose={() => setCloudDeleteTarget(null)}
            onDeleted={(result) => {
              setDeleteNotice(
                result.bridge_cleanup_failures.length > 0
                  ? {
                      severity: "warning",
                      text:
                        `Deleted, but its chat platform clean-up did not finish (` +
                        `${result.bridge_cleanup_failures.join("; ")}). It will be finished when that bridge next starts.`,
                    }
                  : null,
              );
              refetch();
              cloud.refresh();
            }}
          />
        )}
      </Suspense>

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Delete agent</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete agent &quot;{deleteTarget?.name}&quot;? This
            will stop the agent&apos;s client and remove all associated tools and models.
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
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <RegisterAgentDialog
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onRegistered={refetch}
      />
      <Suspense fallback={null}>
        {cloudAgents && (
          <CloudAgentDialog
            open={cloudOpen}
            onClose={() => setCloudOpen(false)}
            onCreated={() => {
              refetch();
              cloud.refresh();
            }}
          />
        )}
      </Suspense>
    </Box>
  );
}
