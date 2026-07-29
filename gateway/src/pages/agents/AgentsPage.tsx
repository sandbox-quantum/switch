import AddCircleOutline from "@mui/icons-material/AddCircleOutline";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import SearchIcon from "@mui/icons-material/Search";
import {
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
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid-pro";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import DataTable from "../../components/DataTable";
import { type AgentSummary, deleteAgent } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { useAgents } from "../../data/hooks";
import { EM_DASH, formatDate, titleCase } from "../../theme/hootFormat";
import RegisterAgentDialog from "./RegisterAgentDialog";

// Connector type is a category, not a status. Colour here would compete with
// the status hues for the reader's attention and mean nothing, so the tag is
// neutral and the label carries the distinction.

export default function AgentsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data: agents, loading, refetch } = useAgents();
  const [deleteTarget, setDeleteTarget] = useState<AgentSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
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
        !a.description.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [agents, ownerFilter, typeFilter, parentFilter, search]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    await deleteAgent(deleteTarget.id);
    setDeleteTarget(null);
    setDeleting(false);
    refetch();
  }, [deleteTarget, refetch]);

  const columns = useMemo<GridColDef<AgentSummary>[]>(
    () => [
      { field: "name", headerName: "Name", flex: 1, minWidth: 200 },
      {
        field: "connector_type",
        headerName: "Agent Type",
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
        headerName: "Connection Type",
        width: 170,
        valueFormatter: (value) => (value ? titleCase(value as string) : EM_DASH),
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
          const canModify = isAdmin || row.owner_id === user?.id;
          if (!canModify) return null;
          return (
            <>
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteTarget(row);
                }}
              >
                <DeleteOutline fontSize="small" />
              </IconButton>
            </>
          );
        },
      },
    ],
    [isAdmin, user?.id, parentNameById],
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}>
        <Typography variant="h5">Agents</Typography>
        <Button
          variant="contained"
          startIcon={<AddCircleOutline />}
          onClick={() => setRegisterOpen(true)}
        >
          Register Agent
        </Button>
      </Stack>

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
    </Box>
  );
}
