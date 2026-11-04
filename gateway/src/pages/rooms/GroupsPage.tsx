import AddIcon from "@mui/icons-material/Add";
import ArrowBack from "@mui/icons-material/ArrowBack";
import Close from "@mui/icons-material/Close";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import EditOutlined from "@mui/icons-material/EditOutlined";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import SearchablePickerDialog, {
  type PickerOption,
} from "../../components/SearchablePickerDialog";
import {
  type RoomGroupDetail,
  type RoomSummary,
  assignRoomsToGroup,
  createRoomGroup,
  deleteRoomGroup,
  setRoomGroup,
  updateRoomGroup,
} from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { useRoomGroups, useRooms } from "../../data/hooks";
import {
  ancestorChain,
  buildGroupIndex,
  effectiveColor,
  flattenTree,
  groupPathName,
} from "./groupTree";

const STANDALONE = "__standalone__";

function ColorDot({ color, size = 12 }: { color: string; size?: number }) {
  return (
    <Box
      sx={{ width: size, height: size, borderRadius: "50%", bgcolor: color, flexShrink: 0 }}
    />
  );
}

// ── Create / edit dialog ──────────────────────────────────────────────────────

function GroupFormDialog({
  open,
  group,
  groups,
  onClose,
  onSaved,
}: {
  open: boolean;
  group: RoomGroupDetail | null;
  groups: RoomGroupDetail[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = group !== null;
  const [name, setName] = useState(group?.name ?? "");
  const [color, setColor] = useState(group?.color ?? "#7EB6FF");
  const [parentId, setParentId] = useState(group?.parent_group_id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset fields whenever the target group (or open state) changes.
  const formKey = `${open}:${group?.id ?? "new"}`;
  const [lastKey, setLastKey] = useState(formKey);
  if (formKey !== lastKey) {
    setLastKey(formKey);
    setName(group?.name ?? "");
    setColor(group?.color ?? "#7EB6FF");
    setParentId(group?.parent_group_id ?? "");
    setError(null);
  }

  // Parent options exclude the group itself and its descendants (cycle guard).
  const parentOptions = useMemo(() => {
    const byId = buildGroupIndex(groups);
    const banned = new Set<string>();
    if (group) {
      for (const g of groups) {
        if (ancestorChain(g.id, byId).some((a) => a.id === group.id)) banned.add(g.id);
      }
    }
    return flattenTree(groups)
      .filter(({ group: g }) => !banned.has(g.id))
      .map(({ group: g, depth }) => ({ id: g.id, label: `${"  ".repeat(depth)}${g.name}` }));
  }, [groups, group]);

  const submit = useCallback(async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (editing && group) {
        await updateRoomGroup(group.id, {
          name: name.trim(),
          color,
          parent_group_id: parentId || null,
        });
      } else {
        await createRoomGroup({
          name: name.trim(),
          color,
          parent_group_id: parentId || null,
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save group");
    } finally {
      setBusy(false);
    }
  }, [editing, group, name, color, parentId, onSaved, onClose]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{editing ? "Edit group" : "New group"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField
              label="Name"
              size="small"
              value={name}
              onChange={(e) => setName(e.target.value)}
              fullWidth
              autoFocus
            />
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label="Group colour"
              style={{ width: 40, height: 40, border: "none", background: "none", cursor: "pointer" }}
            />
          </Stack>
          <TextField
            select
            size="small"
            label="Parent group"
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            fullWidth
          >
            <MenuItem value="">— Top level —</MenuItem>
            {parentOptions.map((o) => (
              <MenuItem key={o.id} value={o.id}>
                {o.label}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={busy || !name.trim()}>
          {editing ? "Save" : "Create"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Left panel: the group tree ────────────────────────────────────────────────

function GroupTree({
  groups,
  byId,
  standaloneCount,
  selectedId,
  canManage,
  onSelect,
  onEdit,
  onDelete,
}: {
  groups: RoomGroupDetail[];
  byId: Map<string, RoomGroupDetail>;
  standaloneCount: number;
  selectedId: string | null;
  canManage: boolean;
  onSelect: (id: string) => void;
  onEdit: (group: RoomGroupDetail) => void;
  onDelete: (group: RoomGroupDetail) => void;
}) {
  const ordered = useMemo(() => flattenTree(groups), [groups]);
  return (
    <Stack spacing={0.5}>
      {ordered.map(({ group, depth }) => {
        const selected = group.id === selectedId;
        return (
          <Stack
            key={group.id}
            direction="row"
            alignItems="center"
            spacing={1}
            onClick={() => onSelect(group.id)}
            sx={{
              pl: depth * 2 + 1,
              pr: 0.5,
              py: 0.75,
              borderRadius: 1,
              cursor: "pointer",
              bgcolor: selected ? "action.selected" : "transparent",
              "&:hover": { bgcolor: selected ? "action.selected" : "action.hover" },
              "&:hover .group-actions": { opacity: 1 },
            }}
          >
            <ColorDot color={effectiveColor(group.id, byId)} />
            <Typography variant="body2" sx={{ flexGrow: 1, fontWeight: selected ? 600 : 400 }} noWrap>
              {group.name}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {group.room_count}
            </Typography>
            {canManage && (
            <Stack
              direction="row"
              className="group-actions"
              sx={{ opacity: 0, transition: "opacity 0.1s" }}
            >
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(group);
                }}
                aria-label={`Edit ${group.name}`}
              >
                <EditOutlined fontSize="small" />
              </IconButton>
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(group);
                }}
                aria-label={`Delete ${group.name}`}
              >
                <DeleteOutline fontSize="small" />
              </IconButton>
            </Stack>
            )}
          </Stack>
        );
      })}

      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        onClick={() => onSelect(STANDALONE)}
        sx={{
          pl: 1,
          py: 0.75,
          mt: 1,
          borderRadius: 1,
          cursor: "pointer",
          borderTop: 1,
          borderColor: "divider",
          bgcolor: selectedId === STANDALONE ? "action.selected" : "transparent",
          "&:hover": {
            bgcolor: selectedId === STANDALONE ? "action.selected" : "action.hover",
          },
        }}
      >
        <ColorDot color="#5A5F66" />
        <Typography
          variant="body2"
          sx={{ flexGrow: 1, fontStyle: "italic", color: "text.secondary" }}
        >
          Standalone
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {standaloneCount}
        </Typography>
      </Stack>
    </Stack>
  );
}

// ── Right panel: rooms in the selected group ──────────────────────────────────

function MembershipPanel({
  selectedId,
  group,
  byId,
  rooms,
  onChanged,
}: {
  selectedId: string | null;
  group: RoomGroupDetail | null;
  byId: Map<string, RoomGroupDetail>;
  rooms: RoomSummary[];
  onChanged: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isStandalone = selectedId === STANDALONE;

  const memberRooms = useMemo(
    () =>
      rooms.filter((r) =>
        isStandalone ? r.group_id === null : r.group_id === selectedId,
      ),
    [rooms, selectedId, isStandalone],
  );

  // Rooms eligible to add: everything not already directly in this group.
  const addableOptions = useMemo<PickerOption[]>(
    () =>
      rooms
        .filter((r) => r.group_id !== selectedId)
        .map((r) => ({
          id: r.id,
          primary: r.name,
          secondary: r.group_id
            ? `Currently in ${groupPathName(r.group_id, byId) || r.group_name || "a group"}`
            : "Standalone",
          search: `${r.name} ${r.group_name ?? ""}`.toLowerCase(),
        })),
    [rooms, selectedId, byId],
  );

  const handleAdd = useCallback(
    async (roomIds: string[]) => {
      if (!selectedId || isStandalone) return;
      setError(null);
      try {
        await assignRoomsToGroup(selectedId, roomIds);
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add rooms");
        throw err;
      }
    },
    [selectedId, isStandalone, onChanged],
  );

  const handleRemove = useCallback(
    async (roomId: string) => {
      setError(null);
      try {
        await setRoomGroup(roomId, null);
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove room");
      }
    },
    [onChanged],
  );

  if (!selectedId) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100%", py: 8 }}>
        <Typography variant="body2" color="text.secondary">
          Select a group to manage its rooms.
        </Typography>
      </Stack>
    );
  }

  const title = isStandalone
    ? "Standalone rooms"
    : group
      ? groupPathName(group.id, byId)
      : "Group";

  return (
    <Stack spacing={2} sx={{ height: "100%" }}>
      <Stack direction="row" alignItems="center" spacing={1.5}>
        {!isStandalone && group && <ColorDot color={effectiveColor(group.id, byId)} />}
        <Typography variant="h6" sx={{ flexGrow: 1 }} noWrap>
          {title}
        </Typography>
        {!isStandalone && (
          <Button
            variant="contained"
            size="small"
            startIcon={<AddIcon />}
            onClick={() => setPickerOpen(true)}
          >
            Add rooms
          </Button>
        )}
      </Stack>

      {error && <Alert severity="error">{error}</Alert>}

      {isStandalone && (
        <Typography variant="body2" color="text.secondary">
          These rooms aren't in any group. Select a group and use “Add rooms” to
          organize them.
        </Typography>
      )}

      {memberRooms.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No rooms here yet.
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {memberRooms.map((room) => (
            <Stack
              key={room.id}
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{ px: 1.5, py: 0.75, borderRadius: 1, border: 1, borderColor: "divider" }}
            >
              <Typography variant="body2" sx={{ flexGrow: 1 }} noWrap>
                {room.name}
              </Typography>
              {!isStandalone && (
                <IconButton
                  size="small"
                  onClick={() => handleRemove(room.id)}
                  aria-label={`Remove ${room.name} from group`}
                >
                  <Close fontSize="small" />
                </IconButton>
              )}
            </Stack>
          ))}
        </Stack>
      )}

      <SearchablePickerDialog
        open={pickerOpen}
        title="Add rooms to group"
        searchPlaceholder="Search rooms…"
        submitLabel="Add"
        options={addableOptions}
        onClose={() => setPickerOpen(false)}
        onSubmit={handleAdd}
      />
    </Stack>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function GroupsPage() {
  const navigate = useNavigate();
  // Groups are shared by the workspace, so only an admin creates, edits or
  // deletes them; anyone may file rooms they can write into one.
  const { canAdminTenant: canManageGroups } = useAuth();
  const { data: groups, loading, refetch } = useRoomGroups();
  const { data: rooms, refetch: refetchRooms } = useRooms();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editGroup, setEditGroup] = useState<RoomGroupDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RoomGroupDetail | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const groupList = useMemo(() => groups ?? [], [groups]);
  const roomList = useMemo(() => rooms ?? [], [rooms]);
  const byId = useMemo(() => buildGroupIndex(groupList), [groupList]);
  const standaloneCount = useMemo(
    () => roomList.filter((r) => r.group_id === null).length,
    [roomList],
  );

  const selectedGroup =
    selectedId && selectedId !== STANDALONE ? (byId.get(selectedId) ?? null) : null;

  const refetchAll = useCallback(() => {
    refetch();
    refetchRooms();
  }, [refetch, refetchRooms]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteError(null);
    try {
      await deleteRoomGroup(deleteTarget.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete group");
      return;
    }
    if (selectedId === deleteTarget.id) setSelectedId(null);
    setDeleteTarget(null);
    refetchAll();
  }, [deleteTarget, selectedId, refetchAll]);

  const closeDelete = useCallback(() => {
    setDeleteTarget(null);
    setDeleteError(null);
  }, []);

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <IconButton onClick={() => navigate("/rooms")} size="small">
          <ArrowBack />
        </IconButton>
        <Typography variant="h5" sx={{ flexGrow: 1 }}>
          Room groups
        </Typography>
        {canManageGroups && (
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              setEditGroup(null);
              setFormOpen(true);
            }}
          >
            New group
          </Button>
        )}
      </Stack>

      {loading ? (
        <CircularProgress />
      ) : (
        <Stack direction="row" spacing={2} sx={{ alignItems: "stretch" }}>
          <Paper variant="outlined" sx={{ borderRadius: 2, p: 1.5, width: 320, flexShrink: 0 }}>
            {groupList.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
                {canManageGroups
                  ? "No groups yet. Create one to start organizing rooms."
                  : "No groups yet. A workspace admin can create them."}
              </Typography>
            ) : (
              <GroupTree
                groups={groupList}
                byId={byId}
                standaloneCount={standaloneCount}
                selectedId={selectedId}
                canManage={canManageGroups}
                onSelect={setSelectedId}
                onEdit={(g) => {
                  setEditGroup(g);
                  setFormOpen(true);
                }}
                onDelete={(g) => setDeleteTarget(g)}
              />
            )}
          </Paper>

          <Paper variant="outlined" sx={{ borderRadius: 2, p: 3, flexGrow: 1, minHeight: 400 }}>
            <MembershipPanel
              selectedId={selectedId}
              group={selectedGroup}
              byId={byId}
              rooms={roomList}
              onChanged={refetchAll}
            />
          </Paper>
        </Stack>
      )}

      <GroupFormDialog
        open={formOpen}
        group={editGroup}
        groups={groupList}
        onClose={() => setFormOpen(false)}
        onSaved={refetchAll}
      />

      <Dialog open={deleteTarget !== null} onClose={closeDelete}>
        <DialogTitle>Delete group?</DialogTitle>
        <DialogContent>
          {deleteError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {deleteError}
            </Alert>
          )}
          <Typography variant="body2">
            Delete <b>{deleteTarget?.name}</b>? Its rooms become standalone and any
            subgroups move up to this group's parent. This cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDelete}>Cancel</Button>
          <Button color="error" variant="contained" onClick={handleDelete}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
