import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  ListItemText,
  MenuItem,
  OutlinedInput,
  Radio,
  RadioGroup,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { type RoomRoleSpec, createRoom } from "../../data/api";
import { AccessSelect } from "../../components/AccessControls";
import { type AccessLevel, fromAccessLevel } from "../../data/visibility";
import { useAgents, useBridges, useBridgeUsers, useRoomGroups } from "../../data/hooks";
import { flattenTree } from "./groupTree";

type ChannelSource = "existing" | "new";

export default function RoomCreateFormBody() {
  const navigate = useNavigate();
  const { data: agents } = useAgents();
  const { data: bridges } = useBridges();
  const { data: groups } = useRoomGroups();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [bridgeId, setBridgeId] = useState("");
  const [channelSource, setChannelSource] = useState<ChannelSource>("new");
  const [externalChannelId, setExternalChannelId] = useState("");
  const [newChannelType, setNewChannelType] = useState<"channel_public" | "channel_private">("channel_public");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  // Per-agent opt-in: ids of selected agents whose subagents to also add.
  const [includeSubagentsFor, setIncludeSubagentsFor] = useState<string[]>([]);
  // Per-agent opt-in: ids of selected agents that should receive room_join
  // events in this room.
  const [joinEventListeners, setJoinEventListeners] = useState<string[]>([]);
  const [userNames, setUserNames] = useState<string[]>([]);
  const [access, setAccess] = useState<AccessLevel>("public");
  const [groupId, setGroupId] = useState("");
  const [roles, setRoles] = useState<RoomRoleSpec[]>([]);

  const { data: bridgeUsers } = useBridgeUsers(bridgeId || undefined);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasBridge = !!bridgeId;

  const addRole = useCallback(
    () => setRoles((rs) => [...rs, { name: "", instructions: "", exclusive: false }]),
    [],
  );
  const updateRole = useCallback(
    (idx: number, patch: Partial<RoomRoleSpec>) =>
      setRoles((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r))),
    [],
  );
  const removeRole = useCallback(
    (idx: number) => setRoles((rs) => rs.filter((_, i) => i !== idx)),
    [],
  );

  const eligibleAgents = useMemo(() => agents ?? [], [agents]);

  const agentNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents ?? []) m.set(a.id, a.name);
    return m;
  }, [agents]);

  // How many subagents each agent has, so we can offer an "include subagents"
  // toggle only for the selected agents that actually have any.
  const childCountByParent = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of agents ?? []) {
      if (a.parent_agent_id)
        m.set(a.parent_agent_id, (m.get(a.parent_agent_id) ?? 0) + 1);
    }
    return m;
  }, [agents]);

  const selectedAgentsWithSubagents = useMemo(
    () => agentIds.filter((id) => (childCountByParent.get(id) ?? 0) > 0),
    [agentIds, childCountByParent],
  );

  const canSubmit = useMemo(() => {
    if (!name.trim() || !description.trim()) return false;
    if (hasBridge) {
      if (channelSource === "existing" && !externalChannelId.trim()) return false;
      return true;
    }
    return agentIds.length >= 1;
  }, [name, description, hasBridge, channelSource, externalChannelId, agentIds]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      let channelType: string | undefined;
      let extId: string | undefined;

      if (hasBridge) {
        if (channelSource === "existing") {
          extId = externalChannelId.trim();
        } else {
          channelType = newChannelType;
        }
      } else {
        channelType = "channel_public";
      }

      const room = await createRoom({
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim() || null,
        channel_type: channelType,
        agent_ids: agentIds.length > 0 ? agentIds : undefined,
        include_subagents_for: (() => {
          const sel = includeSubagentsFor.filter((id) => agentIds.includes(id));
          return sel.length > 0 ? sel : undefined;
        })(),
        join_event_listeners: (() => {
          const sel = joinEventListeners.filter((id) => agentIds.includes(id));
          return sel.length > 0 ? sel : undefined;
        })(),
        user_names: userNames.length > 0 ? userNames : undefined,
        bridge_id: bridgeId || undefined,
        external_channel_id: extId,
        group_id: groupId || null,
        roles:
          roles.filter((r) => r.name.trim()).length > 0
            ? roles
                .filter((r) => r.name.trim())
                .map((r) => ({
                  name: r.name.trim(),
                  instructions: r.instructions,
                  exclusive: r.exclusive,
                }))
            : undefined,
        ...fromAccessLevel(access),
      });
      navigate(`/rooms/${room.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create room.");
      setSubmitting(false);
    }
  }, [
    canSubmit,
    name,
    description,
    instructions,
    hasBridge,
    channelSource,
    externalChannelId,
    newChannelType,
    agentIds,
    includeSubagentsFor,
    joinEventListeners,
    bridgeId,
    userNames,
    access,
    groupId,
    roles,
    navigate,
  ]);

  return (
    <Stack spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}
      <TextField
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        fullWidth
        required
      />
      <TextField
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        fullWidth
        required
        multiline
        rows={2}
      />
      <TextField
        label="Instructions"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        fullWidth
        multiline
        rows={4}
        helperText="Surfaced to agents on connect. Use this to set the room's purpose, rules, or expected outputs."
      />

      <AccessSelect value={access} onChange={setAccess} disabled={submitting} />

      {(groups ?? []).length > 0 && (
        <TextField
          select
          label="Group (optional)"
          value={groupId}
          onChange={(e) => setGroupId(e.target.value)}
          fullWidth
          helperText="Add this room to an existing group for navigation and graph colouring."
        >
          <MenuItem value="">None (standalone)</MenuItem>
          {flattenTree(groups ?? []).map(({ group, depth }) => (
            <MenuItem key={group.id} value={group.id}>
              {"  ".repeat(depth)}
              {group.name}
            </MenuItem>
          ))}
        </TextField>
      )}

      <Divider />
      <Stack spacing={1}>
        <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
          Roles (optional)
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Assumable instruction bundles agents can pick up in this room.
          Exclusive roles allow at most one holder at a time.
        </Typography>
        {roles.map((role, idx) => (
          <Box
            key={idx}
            sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5 }}
          >
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} alignItems="center">
                <TextField
                  label="Name"
                  size="small"
                  value={role.name}
                  onChange={(e) => updateRole(idx, { name: e.target.value })}
                  sx={{ flexGrow: 1 }}
                />
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={role.exclusive}
                      onChange={(e) =>
                        updateRole(idx, { exclusive: e.target.checked })
                      }
                    />
                  }
                  label="Exclusive"
                />
                <IconButton size="small" onClick={() => removeRole(idx)}>
                  <DeleteOutline fontSize="small" />
                </IconButton>
              </Stack>
              <TextField
                label="Instructions"
                size="small"
                value={role.instructions}
                onChange={(e) => updateRole(idx, { instructions: e.target.value })}
                fullWidth
                multiline
                rows={2}
              />
            </Stack>
          </Box>
        ))}
        <Button
          size="small"
          variant="outlined"
          startIcon={<AddIcon />}
          onClick={addRole}
          sx={{ alignSelf: "flex-start" }}
        >
          Add role
        </Button>
      </Stack>
      <Divider />

      <TextField
        select
        label="Bridge (optional)"
        value={bridgeId}
        onChange={(e) => {
          setBridgeId(e.target.value);
          if (!e.target.value) {
            setChannelSource("new");
            setExternalChannelId("");
          }
        }}
        fullWidth
      >
        <MenuItem value="">None (internal only)</MenuItem>
        {(bridges ?? []).map((b) => (
          <MenuItem key={b.bridge_id} value={b.bridge_id}>
            {b.display_name} ({b.bridge_type})
          </MenuItem>
        ))}
      </TextField>

      {hasBridge && (
        <>
          <RadioGroup
            row
            value={channelSource}
            onChange={(e) => setChannelSource(e.target.value as ChannelSource)}
          >
            <FormControlLabel
              value="new"
              control={<Radio size="small" />}
              label="Create new channel"
            />
            <FormControlLabel
              value="existing"
              control={<Radio size="small" />}
              label="Use existing channel"
            />
          </RadioGroup>

          {channelSource === "existing" ? (
            <TextField
              label="External channel ID"
              value={externalChannelId}
              onChange={(e) => setExternalChannelId(e.target.value)}
              fullWidth
              required
              helperText="Paste the channel ID from the external platform. Channel type will be detected automatically."
            />
          ) : (
            <TextField
              select
              label="Channel type"
              value={newChannelType}
              onChange={(e) =>
                setNewChannelType(e.target.value as "channel_public" | "channel_private")
              }
              fullWidth
            >
              <MenuItem value="channel_public">Public channel</MenuItem>
              <MenuItem value="channel_private">Private channel</MenuItem>
            </TextField>
          )}
        </>
      )}

      <Autocomplete
        multiple
        disableCloseOnSelect
        options={eligibleAgents}
        value={eligibleAgents.filter((a) => agentIds.includes(a.id))}
        onChange={(_e, selected) => {
          const ids = selected.map((a) => a.id);
          setAgentIds(ids);
          // Drop subagent opt-ins for agents that were just removed.
          setIncludeSubagentsFor((prev) => prev.filter((id) => ids.includes(id)));
        }}
        getOptionLabel={(a) => a.name}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        filterSelectedOptions
        renderOption={(props, a) => {
          const { key, ...rest } = props as typeof props & { key: string };
          const childCount = childCountByParent.get(a.id) ?? 0;
          return (
            <li key={key} {...rest}>
              <ListItemText
                primary={a.name}
                secondary={
                  childCount > 0
                    ? `${a.connector_type} · ${childCount} subagent(s)`
                    : a.connector_type
                }
              />
            </li>
          );
        }}
        renderTags={(value, getTagProps) =>
          value.map((a, index) => {
            const { key, ...rest } = getTagProps({ index });
            return <Chip key={key} {...rest} label={a.name} size="small" />;
          })
        }
        renderInput={(params) => (
          <TextField
            {...params}
            label="Agents"
            placeholder={agentIds.length === 0 ? "Search agents…" : ""}
          />
        )}
      />

      {selectedAgentsWithSubagents.length > 0 && (
        <Stack spacing={0.5} sx={{ pl: 1 }}>
          <Typography variant="caption" color="text.secondary">
            Include subagents
          </Typography>
          {selectedAgentsWithSubagents.map((id) => (
            <FormControlLabel
              key={id}
              control={
                <Checkbox
                  size="small"
                  checked={includeSubagentsFor.includes(id)}
                  onChange={(e) =>
                    setIncludeSubagentsFor((prev) =>
                      e.target.checked
                        ? [...prev, id]
                        : prev.filter((x) => x !== id),
                    )
                  }
                />
              }
              label={`Also add ${childCountByParent.get(id)} subagent(s) of ${
                agentNameById.get(id) ?? id
              }`}
            />
          ))}
        </Stack>
      )}

      {agentIds.length > 0 && (
        <Stack spacing={0.5} sx={{ pl: 1 }}>
          <Typography variant="caption" color="text.secondary">
            Listen to join events
          </Typography>
          {agentIds.map((id) => (
            <FormControlLabel
              key={id}
              control={
                <Checkbox
                  size="small"
                  checked={joinEventListeners.includes(id)}
                  onChange={(e) =>
                    setJoinEventListeners((prev) =>
                      e.target.checked
                        ? [...prev, id]
                        : prev.filter((x) => x !== id),
                    )
                  }
                />
              }
              label={`Notify ${
                agentNameById.get(id) ?? id
              } when someone joins the room`}
            />
          ))}
        </Stack>
      )}

      {hasBridge && (
        <FormControl fullWidth>
          <InputLabel id="users-label">Users</InputLabel>
          <Select
            labelId="users-label"
            multiple
            value={userNames}
            onChange={(e) => {
              const v = e.target.value;
              setUserNames(typeof v === "string" ? v.split(",") : v);
            }}
            input={<OutlinedInput label="Users" />}
            renderValue={(selected) => (
              <Stack direction="row" spacing={0.5} flexWrap="wrap">
                {selected.filter(Boolean).map((n) => (
                  <Chip key={n} label={n} size="small" />
                ))}
              </Stack>
            )}
          >
            {(bridgeUsers ?? []).map((u) => (
              <MenuItem key={u.id} value={u.external_username}>
                <Checkbox
                  checked={userNames.includes(u.external_username)}
                  size="small"
                />
                <ListItemText
                  primary={u.external_username}
                  secondary={u.external_user_id}
                />
              </MenuItem>
            ))}
            {(bridgeUsers ?? []).length === 0 && (
              <MenuItem disabled value="">
                <ListItemText
                  primary="No users known on this bridge yet"
                  secondary="Users appear here after they first interact with the bridge."
                />
              </MenuItem>
            )}
          </Select>
        </FormControl>
      )}

      <Divider />
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button onClick={() => navigate("/rooms")} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={!canSubmit || submitting}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
        >
          Create
        </Button>
      </Stack>
    </Stack>
  );
}
