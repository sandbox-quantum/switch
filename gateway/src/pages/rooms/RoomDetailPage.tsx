import AddIcon from "@mui/icons-material/Add";
import ArchiveOutlined from "@mui/icons-material/ArchiveOutlined";
import ArrowBack from "@mui/icons-material/ArrowBack";
import Close from "@mui/icons-material/Close";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import NotificationsActiveOutlined from "@mui/icons-material/NotificationsActiveOutlined";
import UnarchiveOutlined from "@mui/icons-material/UnarchiveOutlined";
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
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import SearchablePickerDialog, {
  type PickerOption,
} from "../../components/SearchablePickerDialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  type RoomDetail,
  type RoomRoleDetail,
  addRoomAgents,
  addRoomUsers,
  archiveRoom,
  createRoomRole,
  deleteRoom,
  deleteRoomRole,
  removeRoomAgent,
  setRoomAgentJoinEvents,
  setRoomGroup,
  unarchiveRoom,
  updateRoom,
  updateRoomRole,
} from "../../data/api";
import { useAgents, useBridgeUsers, useRoom, useRoomGroups } from "../../data/hooks";
import { useAuth } from "../../data/AuthContext";
import { AccessChip, AccessSelect } from "../../components/AccessControls";
import { type AccessLevel, fromAccessLevel, toAccessLevel } from "../../data/visibility";
import {
  EM_DASH,
  MONO_SX,
  channelTypeLabel,
  formatDateTime,
  titleCase,
} from "../../theme/hootFormat";
import { effectiveColor, buildGroupIndex, flattenTree } from "./groupTree";
import RoomGraphView from "./RoomGraphView";
import RoomLinkedRoomsSection from "./RoomLinkedRoomsSection";
import RoomResourcesSection from "./RoomResourcesSection";
import ExportRoomYamlDialog from "./ExportRoomYamlDialog";

export default function RoomDetailPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: room, loading, error, refetch } = useRoom(roomId);
  const [exportOpen, setExportOpen] = useState(false);

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !room) {
    return (
      <Box>
        <Button startIcon={<ArrowBack />} onClick={() => navigate("/rooms")}>
          Back to rooms
        </Button>
        <Alert severity="error" sx={{ mt: 2 }}>
          {error ?? "Room not found"}
        </Alert>
      </Box>
    );
  }

  // Room write access: owner, admin, or a publicly-writable room.
  const canWrite =
    !!user &&
    (user.id === room.owner_id ||
      user.role === "admin" ||
      room.write_visibility === "public");
  // Delete is stricter — owner or admin only, never via public write.
  const canDelete =
    !!user && (user.id === room.owner_id || user.role === "admin");

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <IconButton onClick={() => navigate("/rooms")} size="small">
          <ArrowBack />
        </IconButton>
        <Typography variant="h5" sx={{ flexGrow: 1 }}>
          {room.name}
        </Typography>
        {room.archived && (
          <Chip label="Archived" size="small" color="warning" />
        )}
        {room.channel_type && (
          <Chip label={channelTypeLabel(room.channel_type)} size="small" />
        )}
        {room.bridge_display_name && (
          <Chip label={room.bridge_display_name} size="small" color="info" />
        )}
        <Button variant="outlined" size="small" onClick={() => setExportOpen(true)}>
          Export to YAML
        </Button>
      </Stack>

      <Stack spacing={4}>
        <RoomInfoSection room={room} />
        <Divider />
        <GroupSection room={room} canWrite={canWrite} onChanged={refetch} />
        <Divider />
        <RolesSection room={room} canWrite={canWrite} onChanged={refetch} />
        <Divider />
        <EditableFieldsSection
          room={room}
          canWrite={canWrite}
          onSaved={refetch}
        />
        <Divider />
        <ParticipantsSection room={room} onChanged={refetch} />
        <Divider />
        <RoomResourcesSection roomId={room.id} />
        <Divider />
        <RoomLinkedRoomsSection roomId={room.id} />
        <Divider />
        <RoomGraphView roomId={room.id} />
        {room.bridge_id && (
          <>
            <Divider />
            <BridgeSection room={room} />
          </>
        )}
        {canWrite && (
          <>
            <Divider />
            <ArchiveSection room={room} onChanged={refetch} />
          </>
        )}
        {canDelete && (
          <>
            <Divider />
            <DangerSection room={room} onDeleted={() => navigate("/rooms")} />
          </>
        )}
      </Stack>

      <ExportRoomYamlDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        roomId={room.id}
        roomName={room.name}
      />
    </Box>
  );
}

// ── Room info (read-only) ───────────────────────────────────────────────────

function RoomInfoSection({ room }: { room: RoomDetail }) {
  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Room info
      </Typography>
      <Stack direction="row" spacing={2} flexWrap="wrap" alignItems="center">
        <AccessChip pair={room} />
        {room.channel_type && (
          <InfoChip
            label="Channel type"
            value={channelTypeLabel(room.channel_type)}
          />
        )}
        <InfoChip label="Created" value={formatDateTime(room.created_at)} />
        <InfoChip label="Matrix room" value={room.matrix_room_id} mono />
        {room.external_channel_id && (
          <InfoChip
            label="External channel"
            value={room.external_channel_id}
            mono
          />
        )}
      </Stack>
    </Stack>
  );
}

function InfoChip({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <Typography variant="body2" color="text.secondary">
      <strong>{label}:</strong>{" "}
      {value ? (
        <Box component="span" sx={mono ? MONO_SX : undefined}>
          {value}
        </Box>
      ) : (
        <Box component="span" sx={{ color: "text.secondary" }}>
          {EM_DASH}
        </Box>
      )}
    </Typography>
  );
}

// ── Group ─────────────────────────────────────────────────────────────────────

function GroupSection({
  room,
  canWrite,
  onChanged,
}: {
  room: RoomDetail;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const { data: groups, refetch: refetchGroups } = useRoomGroups();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groupList = useMemo(() => groups ?? [], [groups]);
  const byId = useMemo(() => buildGroupIndex(groupList), [groupList]);

  const handleChange = useCallback(
    async (value: string) => {
      setSaving(true);
      setError(null);
      try {
        await setRoomGroup(room.id, value || null);
        refetchGroups();
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update group");
      } finally {
        setSaving(false);
      }
    },
    [room.id, onChanged, refetchGroups],
  );

  return (
    <Stack spacing={1.5}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Group
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <Stack direction="row" spacing={1.5} alignItems="center">
        {room.group_id && (
          <Box
            sx={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              bgcolor: effectiveColor(room.group_id, byId),
              flexShrink: 0,
            }}
          />
        )}
        <TextField
          select
          size="small"
          label="Group"
          value={room.group_id ?? ""}
          onChange={(e) => handleChange(e.target.value)}
          disabled={saving || !canWrite}
          sx={{ width: 320 }}
          helperText="Groups organise rooms in the list and colour them in the graph."
        >
          <MenuItem value="">Standalone (no group)</MenuItem>
          {flattenTree(groupList).map(({ group, depth }) => (
            <MenuItem key={group.id} value={group.id}>
              {"  ".repeat(depth)}
              {group.name}
            </MenuItem>
          ))}
        </TextField>
      </Stack>
    </Stack>
  );
}

// ── Roles ─────────────────────────────────────────────────────────────────────

function RolesSection({
  room,
  canWrite,
  onChanged,
}: {
  room: RoomDetail;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update roles");
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const roles = room.roles ?? [];

  return (
    <Stack spacing={1.5}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Roles
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Assumable instruction bundles agents pick up in this room. Exclusive
        roles allow at most one live holder at a time.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {roles.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No roles defined.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {roles.map((role) => (
            <RoleRow
              key={role.name}
              roomId={room.id}
              role={role}
              canWrite={canWrite}
              busy={busy}
              onChanged={onChanged}
              run={run}
            />
          ))}
        </Stack>
      )}
      {canWrite && (
        <Button
          size="small"
          variant="outlined"
          startIcon={<AddIcon />}
          onClick={() => setAdding(true)}
          sx={{ alignSelf: "flex-start" }}
        >
          Add role
        </Button>
      )}
      <RoleEditorDialog
        open={adding}
        mode="create"
        busy={busy}
        onClose={() => setAdding(false)}
        onSubmit={async ({ name, instructions, exclusive }) => {
          await run(() =>
            createRoomRole(room.id, {
              name: name.trim(),
              instructions,
              exclusive,
            }),
          );
          setAdding(false);
        }}
      />
    </Stack>
  );
}

// Shared create/edit modal. A generous instructions editor (the inline form
// it replaced was a cramped 2-row field) so multi-line role bundles are
// readable while editing.
function RoleEditorDialog({
  open,
  mode,
  initialName = "",
  initialInstructions = "",
  initialExclusive = false,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: "create" | "edit";
  initialName?: string;
  initialInstructions?: string;
  initialExclusive?: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (values: {
    name: string;
    instructions: string;
    exclusive: boolean;
  }) => void;
}) {
  const [name, setName] = useState(initialName);
  const [instructions, setInstructions] = useState(initialInstructions);
  const [exclusive, setExclusive] = useState(initialExclusive);

  // Re-seed fields each time the dialog opens so it reflects the current role.
  useEffect(() => {
    if (open) {
      setName(initialName);
      setInstructions(initialInstructions);
      setExclusive(initialExclusive);
    }
  }, [open, initialName, initialInstructions, initialExclusive]);

  const trimmedName = name.trim();
  const nameHasSpace = /\s/.test(trimmedName);
  const canSubmit =
    mode === "edit" || (trimmedName.length > 0 && !nameHasSpace);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>
        {mode === "create" ? "Add role" : `Edit role: ${initialName}`}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {mode === "create" && (
            <TextField
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              fullWidth
              autoFocus
              error={nameHasSpace}
              helperText={
                nameHasSpace
                  ? "No spaces — roles are addressed as @name, which must be a single token."
                  : "Single token, no spaces (e.g. manager, code-reviewer)."
              }
            />
          )}
          <FormControlLabel
            control={
              <Switch
                checked={exclusive}
                onChange={(e) => setExclusive(e.target.checked)}
              />
            }
            label="Exclusive — at most one live holder at a time"
          />
          <TextField
            label="Instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            fullWidth
            multiline
            minRows={12}
            maxRows={28}
            helperText="The instruction bundle delivered when an agent assumes this role."
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={busy || !canSubmit}
          onClick={() => onSubmit({ name, instructions, exclusive })}
        >
          {mode === "create" ? "Add" : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function RoleRow({
  roomId,
  role,
  canWrite,
  busy,
  run,
}: {
  roomId: string;
  role: RoomRoleDetail;
  canWrite: boolean;
  busy: boolean;
  onChanged: () => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5 }}>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            {role.name}
          </Typography>
          {role.exclusive && <Chip label="exclusive" size="small" />}
          {role.held_by.length > 0 ? (
            role.held_by.map((holder) => (
              <Chip
                key={holder}
                label={`held by ${holder}`}
                size="small"
                color="success"
              />
            ))
          ) : (
            <Chip label="free" size="small" variant="outlined" />
          )}
          <Box sx={{ flexGrow: 1 }} />
          {canWrite && (
            <Button size="small" onClick={() => setEditing(true)} disabled={busy}>
              Edit
            </Button>
          )}
          {canWrite && (
            <IconButton
              size="small"
              disabled={busy}
              onClick={() => run(() => deleteRoomRole(roomId, role.name))}
            >
              <DeleteOutline fontSize="small" />
            </IconButton>
          )}
        </Stack>
        {role.instructions && (
          <Box
            sx={{
              bgcolor: "action.hover",
              borderRadius: 1,
              px: 1.5,
              py: 1,
              maxHeight: 220,
              overflowY: "auto",
            }}
          >
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
            >
              {role.instructions}
            </Typography>
          </Box>
        )}
      </Stack>
      <RoleEditorDialog
        open={editing}
        mode="edit"
        initialName={role.name}
        initialInstructions={role.instructions}
        initialExclusive={role.exclusive}
        busy={busy}
        onClose={() => setEditing(false)}
        onSubmit={async ({ instructions, exclusive }) => {
          await run(() =>
            updateRoomRole(roomId, role.name, { instructions, exclusive }),
          );
          setEditing(false);
        }}
      />
    </Box>
  );
}

// ── Editable fields ─────────────────────────────────────────────────────────

function EditableFieldsSection({
  room,
  canWrite,
  onSaved,
}: {
  room: RoomDetail;
  canWrite: boolean;
  onSaved: () => void;
}) {
  const [name, setName] = useState(room.name);
  const [description, setDescription] = useState(room.description);
  const [instructions, setInstructions] = useState(room.instructions ?? "");
  const [access, setAccess] = useState<AccessLevel>(toAccessLevel(room));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(room.name);
    setDescription(room.description);
    setInstructions(room.instructions ?? "");
    setAccess(toAccessLevel(room));
  }, [room]);

  const isBridged = !!room.bridge_id;

  const dirty =
    name !== room.name ||
    description !== room.description ||
    instructions !== (room.instructions ?? "") ||
    access !== toAccessLevel(room);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await updateRoom(room.id, {
        name: name !== room.name ? name : undefined,
        description:
          !isBridged && description !== room.description ? description : undefined,
        instructions:
          instructions !== (room.instructions ?? "") ? instructions : undefined,
        ...(access !== toAccessLevel(room) ? fromAccessLevel(access) : {}),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [room, name, description, instructions, access, isBridged, onSaved]);

  return (
    <Stack spacing={2}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Settings
      </Typography>
      {!canWrite && (
        <Alert severity="info">
          You don't have write access to this room. Only its owner and admins
          can change these settings.
        </Alert>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      <TextField
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={!canWrite || saving}
        helperText={
          isBridged
            ? "This is the Switch display name. It does not rename the linked channel on the messaging platform."
            : undefined
        }
      />
      <TextField
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={!canWrite || saving}
        multiline
        rows={2}
        slotProps={{ input: { readOnly: isBridged } }}
      />
      <TextField
        label="Instructions"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        disabled={!canWrite || saving}
        multiline
        minRows={6}
        helperText="Surfaced to agents on connect."
      />
      <AccessSelect
        value={access}
        onChange={setAccess}
        disabled={!canWrite || saving}
        sx={{ maxWidth: 360 }}
      />
      <Box>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={!canWrite || !dirty || saving}
          startIcon={saving ? <CircularProgress size={16} /> : undefined}
        >
          Save
        </Button>
      </Box>
    </Stack>
  );
}

// ── Participants ─────────────────────────────────────────────────────────────

function ParticipantsSection({
  room,
  onChanged,
}: {
  room: RoomDetail;
  onChanged: () => void;
}) {
  const { data: allAgents, loading: agentsLoading } = useAgents();
  const { data: bridgeUsers, loading: bridgeUsersLoading } = useBridgeUsers(
    room.bridge_id ?? undefined,
  );
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const agentNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of allAgents ?? []) m.set(a.id, a.name);
    return m;
  }, [allAgents]);

  const addableAgentOptions = useMemo<PickerOption[]>(
    () =>
      (allAgents ?? [])
        .filter((a) => !room.agent_ids.includes(a.id))
        .map((a) => ({
          id: a.id,
          primary: a.name,
          secondary: a.connector_type ?? "",
          search: `${a.name} ${a.connector_type ?? ""}`.toLowerCase(),
        })),
    [allAgents, room.agent_ids],
  );

  // Subagent counts, so the add-agent picker can offer "include subagents"
  // per selected parent agent.
  const childCountByParent = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of allAgents ?? []) {
      if (a.parent_agent_id)
        m.set(a.parent_agent_id, (m.get(a.parent_agent_id) ?? 0) + 1);
    }
    return m;
  }, [allAgents]);

  const handleAddAgents = useCallback(
    async (ids: string[], includeSubagentsFor: string[]) => {
      setWorking(true);
      setError(null);
      try {
        await addRoomAgents(room.id, ids, includeSubagentsFor);
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add agent");
        throw err;
      } finally {
        setWorking(false);
      }
    },
    [room.id, onChanged],
  );

  const handleRemoveAgent = useCallback(
    async (agentId: string) => {
      setWorking(true);
      setError(null);
      try {
        await removeRoomAgent(room.id, agentId);
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove agent");
      } finally {
        setWorking(false);
      }
    },
    [room.id, onChanged],
  );

  const handleToggleJoinEvents = useCallback(
    async (agentId: string, next: boolean) => {
      setWorking(true);
      setError(null);
      try {
        await setRoomAgentJoinEvents(room.id, agentId, next);
        onChanged();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to update join events",
        );
      } finally {
        setWorking(false);
      }
    },
    [room.id, onChanged],
  );

  const addableUserOptions = useMemo<PickerOption[]>(
    () =>
      (bridgeUsers ?? [])
        .filter((u) => !room.connected_user_names.includes(u.external_username))
        .map((u) => ({
          id: u.external_username,
          primary: u.external_username,
          secondary: u.external_user_id,
          search: `${u.external_username} ${u.external_user_id}`.toLowerCase(),
        })),
    [bridgeUsers, room.connected_user_names],
  );

  const handleAddUsers = useCallback(
    async (names: string[]) => {
      setWorking(true);
      setError(null);
      try {
        await addRoomUsers(room.id, names);
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add user");
        throw err;
      } finally {
        setWorking(false);
      }
    },
    [room.id, onChanged],
  );

  const isFixedMembership = room.channel_type === "group" || room.channel_type === "direct";

  return (
    <Stack spacing={3}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Participants
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}

      <Box>
        <Typography variant="body2" gutterBottom>
          Agents ({room.agent_ids.length})
        </Typography>
        <Stack spacing={0.5} sx={{ mb: 1 }}>
          {room.agent_ids.map((id) => (
            <AgentRow
              key={id}
              agentId={id}
              name={agentNameById.get(id) ?? id}
              status={room.agent_statuses[id]}
              receivesJoinEvents={room.join_event_listeners.includes(id)}
              onToggleJoinEvents={
                working ? undefined : (next) => handleToggleJoinEvents(id, next)
              }
              onRemove={
                isFixedMembership || working
                  ? undefined
                  : () => handleRemoveAgent(id)
              }
            />
          ))}
          {room.agent_ids.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No agents.
            </Typography>
          )}
        </Stack>
        {!isFixedMembership && (
          <>
            <Button
              size="small"
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={() => setAddAgentOpen(true)}
              sx={{ alignSelf: "flex-start" }}
            >
              Add agent
            </Button>
            <SearchablePickerDialog
              open={addAgentOpen}
              title="Add agents"
              searchPlaceholder="Search agents…"
              submitLabel="Add"
              options={addableAgentOptions}
              loading={agentsLoading}
              subToggleCount={(id) => childCountByParent.get(id) ?? 0}
              subToggleLabel={(n) => `Also add ${n} subagent(s)`}
              onClose={() => setAddAgentOpen(false)}
              onSubmit={handleAddAgents}
            />
          </>
        )}
        {isFixedMembership && (
          <Typography variant="caption" color="text.secondary">
            Membership for {channelTypeLabel(room.channel_type)} rooms is managed from the messaging platform.
          </Typography>
        )}
      </Box>

      {room.bridge_id && !isFixedMembership && (
        <Box>
          <Typography variant="body2" gutterBottom>
            Connected users ({room.connected_user_names.length})
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mb: 1 }}>
            {room.connected_user_names.map((name) => (
              <Chip key={name} label={name} size="small" />
            ))}
            {room.connected_user_names.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                No connected users.
              </Typography>
            )}
          </Stack>
          <Button
            size="small"
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={() => setAddUserOpen(true)}
            sx={{ alignSelf: "flex-start" }}
          >
            Add user
          </Button>
          <SearchablePickerDialog
            open={addUserOpen}
            title="Add users"
            searchPlaceholder="Search users…"
            submitLabel="Add"
            options={addableUserOptions}
            loading={bridgeUsersLoading}
            onClose={() => setAddUserOpen(false)}
            onSubmit={handleAddUsers}
          />
        </Box>
      )}
    </Stack>
  );
}

// ── Agent row ────────────────────────────────────────────────────────────────

const STATUS_META: Record<
  string,
  { label: string; color: string; description: string }
> = {
  live: {
    label: "Live",
    color: "var(--hoot-success)",
    description: "Connected and receiving events",
  },
  awaiting_manual_poll: {
    label: "Idle",
    color: "var(--hoot-warning)",
    description: "Session open — awaiting manual poll",
  },
  no_session: {
    label: "No session",
    color: "var(--hoot-muted-foreground)",
    description: "Not currently connected to this room",
  },
  disconnected: {
    label: "Disconnected",
    color: "var(--hoot-destructive)",
    description: "Always-on agent is not connected",
  },
};

function AgentRow({
  agentId,
  name,
  status,
  receivesJoinEvents,
  onToggleJoinEvents,
  onRemove,
}: {
  agentId: string;
  name: string;
  status: string | undefined;
  receivesJoinEvents?: boolean;
  onToggleJoinEvents?: (next: boolean) => void;
  onRemove?: () => void;
}) {
  const navigate = useNavigate();
  const meta = (status && STATUS_META[status]) || {
    label: status ? titleCase(status) : "Unknown",
    color: "var(--hoot-muted-foreground)",
    description: "",
  };
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1.5}
      onClick={() => navigate(`/agents/${agentId}`)}
      sx={{
        px: 1.5,
        py: 0.75,
        borderRadius: 1,
        border: 1,
        borderColor: "divider",
        cursor: "pointer",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Box
        title={meta.description}
        sx={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          bgcolor: meta.color,
          flexShrink: 0,
        }}
      />
      <Typography variant="body2" sx={{ flexGrow: 1 }}>
        {name}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {meta.label}
      </Typography>
      {onToggleJoinEvents && (
        <Tooltip title="When on, this agent is notified when someone joins the room (room_join events) — useful for a welcome/onboarding agent. Does not affect the agent's presence or status.">
          <FormControlLabel
            onClick={(e) => e.stopPropagation()}
            labelPlacement="start"
            sx={{ mr: 0, ml: 0 }}
            control={
              <Switch
                size="small"
                checked={!!receivesJoinEvents}
                onChange={(e) => onToggleJoinEvents(e.target.checked)}
                inputProps={{ "aria-label": `Notify ${name} when someone joins` }}
              />
            }
            label={
              <Stack direction="row" spacing={0.5} alignItems="center">
                <NotificationsActiveOutlined
                  sx={{ fontSize: 15, color: "text.secondary" }}
                />
                <Typography variant="caption" color="text.secondary">
                  Notify on join
                </Typography>
              </Stack>
            }
          />
        </Tooltip>
      )}
      {onRemove && (
        <IconButton
          size="small"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove ${name}`}
        >
          <Close fontSize="small" />
        </IconButton>
      )}
    </Stack>
  );
}

// ── Bridge ───────────────────────────────────────────────────────────────────

function BridgeSection({ room }: { room: RoomDetail }) {
  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Bridge
      </Typography>
      <Stack direction="row" spacing={2} flexWrap="wrap">
        {room.bridge_display_name ? (
          <InfoChip label="Bridge" value={room.bridge_display_name} />
        ) : (
          <InfoChip label="Bridge" value={room.bridge_id} mono />
        )}
        {room.external_channel_id && (
          <InfoChip
            label="External channel"
            value={room.external_channel_id}
            mono
          />
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary">
        Bridge and channel type are immutable after creation. To change them,
        delete the room and create a new one.
      </Typography>
    </Stack>
  );
}

// ── Archive ───────────────────────────────────────────────────────────────────

function ArchiveSection({
  room,
  onChanged,
}: {
  room: RoomDetail;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      if (room.archived) {
        await unarchiveRoom(room.id);
      } else {
        await archiveRoom(room.id);
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update archive state");
    } finally {
      setSaving(false);
    }
  }, [room.id, room.archived, onChanged]);

  return (
    <Stack spacing={2}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Archive
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <Typography variant="body2" color="text.secondary">
        {room.archived
          ? "This room is archived: hidden from the active room list but fully intact and retrievable. Unarchive it to restore it to the active list."
          : "Archiving hides this room from the active room list while keeping it fully intact — the Matrix room, members, and any bridge channel are untouched. It's reversible at any time."}
      </Typography>
      <Box>
        <Button
          variant="outlined"
          startIcon={room.archived ? <UnarchiveOutlined /> : <ArchiveOutlined />}
          onClick={handleToggle}
          disabled={saving}
        >
          {room.archived ? "Unarchive room" : "Archive room"}
        </Button>
      </Box>
    </Stack>
  );
}

// ── Danger ───────────────────────────────────────────────────────────────────

function DangerSection({
  room,
  onDeleted,
}: {
  room: RoomDetail;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      const ok = await deleteRoom(room.id);
      if (!ok) throw new Error("Delete returned false");
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  }, [room.id, onDeleted]);

  return (
    <Stack spacing={2}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Danger zone
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {room.bridge_id && (
        <Alert severity="warning">
          Deleting this room does not delete the external channel on{" "}
          {room.bridge_display_name ?? "the messaging platform"}. You will need
          to remove or archive it manually.
        </Alert>
      )}
      <Box>
        <Button
          variant="outlined"
          color="error"
          startIcon={<DeleteOutline />}
          onClick={() => setOpen(true)}
        >
          Delete room
        </Button>
      </Box>
      <Dialog open={open} onClose={() => setOpen(false)}>
        <DialogTitle>Delete room?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete <b>{room.name}</b>? This removes the
            Matrix room, all client memberships, and any bridge mapping. This
            cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
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
    </Stack>
  );
}
