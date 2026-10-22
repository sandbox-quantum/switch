import ArrowBack from "@mui/icons-material/ArrowBack";
import EditOutlined from "@mui/icons-material/EditOutlined";
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
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  type AgentDetail,
  type AgentRoomMembership,
  type AgentSessionDetail,
  type AgentSummary,
  renameAgent,
  updateAgentOptions,
} from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { useAgent, useKnownAgentTypes } from "../../data/hooks";
import {
  EM_DASH,
  MONO_SX,
  formatDateTime,
  titleCase,
} from "../../theme/hootFormat";
import AddressingPolicySection from "./AddressingPolicySection";
import AgentManagementSection from "./AgentManagementSection";
import ServiceAccessSection from "./ServiceAccessSection";
import { extractDefaults, renderOptionFields } from "./optionFields";
import { sessionPlace, sessionRunner } from "./sessionLabels";

// Presence of an agent within a room — mirrors the room detail page so the two
// views report status identically.
const ROOM_STATUS_META: Record<string, { label: string; color: string }> = {
  live: { label: "Live", color: "var(--hoot-success)" },
  awaiting_manual_poll: { label: "Idle", color: "var(--hoot-warning)" },
  no_session: { label: "No session", color: "var(--hoot-muted-foreground)" },
  disconnected: { label: "Disconnected", color: "var(--hoot-destructive)" },
};

// State of a single session row.
const SESSION_STATE_META: Record<string, { label: string; color: string }> = {
  live: { label: "Live", color: "var(--hoot-success)" },
  open: { label: "Open", color: "var(--hoot-warning)" },
  stale: { label: "Stale", color: "var(--hoot-muted-foreground)" },
};

const NEUTRAL_STATUS_COLOR = "var(--hoot-muted-foreground)";

function StatusDot({ color, title }: { color: string; title?: string }) {
  return (
    <Box
      title={title}
      sx={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        bgcolor: color,
        flexShrink: 0,
      }}
    />
  );
}

export default function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const { user, canAdminTenant } = useAuth();
  const { data: agent, loading, error, refetch } = useAgent(agentId);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameNotice, setRenameNotice] = useState<{
    severity: "success" | "warning";
    lines: string[];
  } | null>(null);

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !agent) {
    return (
      <Box>
        <Button startIcon={<ArrowBack />} onClick={() => navigate("/agents")}>
          Back to agents
        </Button>
        <Alert severity="error" sx={{ mt: 2 }}>
          {error ?? "Agent not found"}
        </Alert>
      </Box>
    );
  }

  const isOwner = !!user && user.id === agent.owner_id;
  // Renaming and editing options are open to the owner or an admin; agent
  // management and service access stay with the owner alone, because the
  // agent then acts on the owner's own machines and credentials.
  const canManage = isOwner || canAdminTenant;

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <IconButton onClick={() => navigate("/agents")} size="small">
          <ArrowBack />
        </IconButton>
        <Typography variant="h5">{agent.name}</Typography>
        {canManage && !agent.parent_agent_id && agent.children.length === 0 && (
          <Tooltip title="Rename agent">
            <IconButton
              size="small"
              aria-label="Rename agent"
              onClick={() => setRenameOpen(true)}
            >
              <EditOutlined fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Chip label={agent.connector_type} size="small" variant="outlined" />
        {agent.connection_model && (
          <Chip
            label={titleCase(agent.connection_model)}
            size="small"
            variant="outlined"
          />
        )}
      </Stack>

      {renameNotice && (
        <Alert
          severity={renameNotice.severity}
          onClose={() => setRenameNotice(null)}
          sx={{ mb: 2 }}
        >
          {renameNotice.lines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </Alert>
      )}

      <RenameAgentDialog
        open={renameOpen}
        agent={agent}
        onClose={() => setRenameOpen(false)}
        onRenamed={(lines, severity) => {
          setRenameOpen(false);
          setRenameNotice({ lines, severity });
          refetch();
        }}
      />

      <Stack spacing={4}>
        <InfoSection agent={agent} />
        <Divider />
        <CapabilitiesSection agent={agent} />
        {agent.known_agent_type && (
          <>
            <Divider />
            <OptionsSection
              agent={agent}
              canEdit={canManage}
              onUpdated={refetch}
            />
          </>
        )}
        <Divider />
        <AddressingPolicySection
          agent={agent}
          canEdit={canManage}
          onUpdated={refetch}
        />
        <AgentManagementSection
          agent={agent}
          canEdit={isOwner}
          onUpdated={refetch}
        />
        {isOwner && <ServiceAccessSection agent={agent} onAgentUpdated={refetch} />}
        <Divider />
        <SessionsSection sessions={agent.sessions} />
        <Divider />
        <RoomsSection rooms={agent.rooms} />
        <Divider />
        <ListSection
          title={`Tools (${agent.tools.length})`}
          empty="No tools."
          items={agent.tools}
        />
        <Divider />
        <ListSection
          title={`Models (${agent.models.length})`}
          empty="No models."
          items={agent.models}
        />
        {agent.children.length > 0 && (
          <>
            <Divider />
            <SubagentsSection children={agent.children} />
          </>
        )}
      </Stack>
    </Box>
  );
}

// "notes-helper" -> "Notes Helper": the label a name usually reads as.
export function labelFromName(name: string): string {
  return name
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function RenameAgentDialog({
  open,
  agent,
  onClose,
  onRenamed,
}: {
  open: boolean;
  agent: AgentDetail;
  onClose: () => void;
  onRenamed: (lines: string[], severity: "success" | "warning") => void;
}) {
  const currentLabel = agent.display_name ?? "";
  // The label follows the name while it is still the name written out; once
  // someone edits it, or it was something else all along, it is left alone.
  const labelFollowsName =
    currentLabel !== "" && currentLabel === labelFromName(agent.name);
  const [name, setName] = useState(agent.name);
  const [displayName, setDisplayName] = useState(currentLabel);
  const [labelEdited, setLabelEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(agent.name);
      setDisplayName(agent.display_name ?? "");
      setLabelEdited(false);
      setError(null);
    }
  }, [open, agent.name, agent.display_name]);

  const trimmed = name.trim();
  const trimmedLabel = displayName.trim();
  const unchanged = trimmed === agent.name && trimmedLabel === currentLabel;
  const suggested = labelFollowsName && !labelEdited && trimmed !== agent.name;

  const changeName = (value: string) => {
    setName(value);
    if (labelFollowsName && !labelEdited) {
      setDisplayName(labelFromName(value.trim()));
    }
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await renameAgent(agent.id, trimmed, trimmedLabel || null);
      const label = result.agent.display_name;
      const lines =
        result.old_name === result.agent.name
          ? [`Display name is now ${label ? `"${label}"` : "cleared"}.`]
          : [
              `Renamed "${result.old_name}" to "${result.agent.name}"` +
                (label ? `, shown as "${label}".` : "."),
            ];
      if (result.bridge_failures.length > 0) {
        lines.push(
          `Not yet updated on: ${result.bridge_failures.join("; ")}. ` +
            "It catches up when that bridge next starts.",
        );
      }
      if (result.templates_mentioning_old_name.length > 0) {
        lines.push(
          "These saved templates still use the old name: " +
            result.templates_mentioning_old_name.join(", ") +
            ".",
        );
      }
      const clean =
        result.bridge_failures.length === 0 &&
        result.templates_mentioning_old_name.length === 0;
      onRenamed(lines, clean ? "success" : "warning");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const submitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !unchanged && trimmed && !saving) void submit();
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>Rename agent</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          The name is what people type to mention the agent; the display name is
          what they read. Its rooms, roles and history stay with it, and
          connected chat platforms are updated too.
        </DialogContentText>
        <Stack spacing={2}>
          <TextField
            autoFocus
            fullWidth
            label="Name"
            value={name}
            onChange={(e) => changeName(e.target.value)}
            onKeyDown={submitOnEnter}
            helperText="Lowercase letters, digits, dots, hyphens and underscores."
            inputProps={{ "aria-label": "New name" }}
          />
          <TextField
            fullWidth
            label="Display name"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setLabelEdited(true);
            }}
            onKeyDown={submitOnEnter}
            helperText={
              suggested
                ? "Suggested from the new name. Change it if you like."
                : "Leave blank to show the name instead."
            }
            inputProps={{ "aria-label": "Display name" }}
          />
        </Stack>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => void submit()}
          disabled={saving || unchanged || !trimmed}
        >
          {saving ? "Saving…" : "Rename"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function InfoLine({
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

function InfoSection({ agent }: { agent: AgentDetail }) {
  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Info
      </Typography>
      {agent.description && (
        <Typography variant="body2">{agent.description}</Typography>
      )}
      <InfoLine label="Display name" value={agent.display_name} />
      {agent.owner_name ? (
        <InfoLine label="Owner" value={agent.owner_name} />
      ) : (
        <InfoLine label="Owner" value={agent.owner_id} mono />
      )}
      <InfoLine label="Agent type" value={agent.connector_type} />
      <InfoLine
        label="Connection type"
        value={agent.connection_model ? titleCase(agent.connection_model) : null}
      />
      <InfoLine label="OAuth client" value={agent.oauth_client_id} mono />
      <InfoLine label="Created" value={formatDateTime(agent.created_at)} />
    </Stack>
  );
}

function boolLabel(value: unknown): string {
  return value ? "Yes" : "No";
}

function CapabilitiesSection({ agent }: { agent: AgentDetail }) {
  const profile = agent.integration_profile;
  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Capabilities
      </Typography>
      <InfoLine
        label="Message exchange"
        value={boolLabel(profile.message_exchange)}
      />
    </Stack>
  );
}

function OptionsSection({
  agent,
  canEdit,
  onUpdated,
}: {
  agent: AgentDetail;
  canEdit: boolean;
  onUpdated: () => void;
}) {
  const { data: knownTypes } = useKnownAgentTypes();
  const spec = knownTypes?.find((t) => t.key === agent.known_agent_type);

  const initial = useMemo(() => {
    if (!spec) return {};
    // Seed with current options, filling any newly-added keys from schema
    // defaults so unset fields still round-trip correctly.
    return {
      ...extractDefaults(spec.options_schema),
      ...(agent.known_agent_options ?? {}),
    };
  }, [spec, agent.known_agent_options]);

  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValues(initial);
    setError(null);
  }, [initial]);

  const dirty = useMemo(
    () => JSON.stringify(values) !== JSON.stringify(initial),
    [values, initial],
  );

  const handleSave = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await updateAgentOptions(agent.id, values);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Stack spacing={2}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Options
      </Typography>
      {!spec ? (
        <Alert severity="warning">
          Unknown agent type "{agent.known_agent_type}" — its schema is no
          longer registered on this server.
        </Alert>
      ) : (
        <>
          {!canEdit && (
            <Typography variant="body2" color="text.secondary">
              Only the agent's owner and admins can edit these options.
            </Typography>
          )}
          <Box sx={{ pointerEvents: canEdit ? "auto" : "none", opacity: canEdit ? 1 : 0.6 }}>
            <Stack spacing={2}>
              {renderOptionFields(spec.options_schema, values, setValues)}
            </Stack>
          </Box>
          {error && <Alert severity="error">{error}</Alert>}
          {canEdit && (
            <Box>
              <Button
                variant="contained"
                onClick={handleSave}
                disabled={!dirty || submitting}
                startIcon={
                  submitting ? <CircularProgress size={16} /> : undefined
                }
              >
                Save
              </Button>
            </Box>
          )}
        </>
      )}
    </Stack>
  );
}

export function SessionsSection({ sessions }: { sessions: AgentSessionDetail[] }) {
  // Live sessions are the agent's real current presence — surface them first.
  const ordered = [...sessions].sort(
    (a, b) => Number(b.state === "live") - Number(a.state === "live"),
  );
  const liveCount = sessions.filter((s) => s.state === "live").length;
  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Sessions ({liveCount} live / {sessions.length})
      </Typography>
      {sessions.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No active sessions.
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {ordered.map((s, i) => (
            <SessionRow key={`${s.room_id ?? "global"}-${i}`} session={s} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function SessionRow({ session }: { session: AgentSessionDetail }) {
  const navigate = useNavigate();
  const meta = SESSION_STATE_META[session.state] ?? {
    label: titleCase(session.state),
    color: NEUTRAL_STATUS_COLOR,
  };
  const isLive = session.state === "live";
  const clickable = session.room_id !== null;
  const runner = sessionRunner(session);
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1.5}
      onClick={
        clickable ? () => navigate(`/rooms/${session.room_id}`) : undefined
      }
      sx={{
        px: 1.5,
        py: 0.75,
        borderRadius: 1,
        border: 1,
        borderColor: isLive ? meta.color : "divider",
        borderLeft: isLive ? `4px solid ${meta.color}` : undefined,
        bgcolor: isLive ? "action.hover" : undefined,
        opacity: isLive ? 1 : 0.55,
        ...(clickable && {
          cursor: "pointer",
          "&:hover": { bgcolor: "action.hover" },
        }),
      }}
    >
      <StatusDot color={meta.color} title={meta.label} />
      <Typography
        variant="body2"
        sx={{
          flexGrow: 1,
          fontWeight: isLive ? 600 : 400,
          ...(!session.room_name && session.room_id ? MONO_SX : {}),
        }}
      >
        {sessionPlace(session)}
      </Typography>
      {runner && (
        <Tooltip title={runner.detail}>
          <Chip
            label={runner.label}
            size="small"
            variant="outlined"
            onClick={(event) => {
              event.stopPropagation();
              navigate("/machines");
            }}
            sx={{ height: 20 }}
          />
        </Tooltip>
      )}
      {isLive ? (
        <Chip
          label={meta.label}
          size="small"
          sx={{
            bgcolor: meta.color,
            color: "common.white",
            fontWeight: 600,
            height: 20,
          }}
        />
      ) : (
        <Typography variant="caption" color="text.secondary">
          {meta.label}
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary">
        last seen {formatDateTime(session.last_seen_at)}
      </Typography>
    </Stack>
  );
}

function RoomsSection({ rooms }: { rooms: AgentRoomMembership[] }) {
  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Rooms ({rooms.length})
      </Typography>
      {rooms.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Not a member of any room.
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {rooms.map((room) => (
            <RoomRow key={room.room_id} room={room} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function RoomRow({ room }: { room: AgentRoomMembership }) {
  const navigate = useNavigate();
  const meta = ROOM_STATUS_META[room.status] ?? {
    label: titleCase(room.status),
    color: NEUTRAL_STATUS_COLOR,
  };
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1.5}
      onClick={() => navigate(`/rooms/${room.room_id}`)}
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
      <StatusDot color={meta.color} title={meta.label} />
      <Typography variant="body2" sx={{ flexGrow: 1 }}>
        {room.room_name}
      </Typography>
      {room.room_role && (
        <Chip
          label={`role: ${room.room_role}`}
          size="small"
          color="primary"
          variant="outlined"
        />
      )}
      {room.archived && (
        <Chip label="archived" size="small" variant="outlined" />
      )}
      <Typography variant="caption" color="text.secondary">
        {meta.label}
      </Typography>
    </Stack>
  );
}

function ListSection({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: { name: string; description: string }[];
}) {
  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        {title}
      </Typography>
      {items.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {empty}
        </Typography>
      ) : (
        <Stack direction="row" flexWrap="wrap" gap={0.5}>
          {items.map((item) => (
            <Chip
              key={item.name}
              label={item.name}
              size="small"
              variant="outlined"
              title={item.description}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function SubagentsSection({ children }: { children: AgentSummary[] }) {
  const navigate = useNavigate();
  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Subagents ({children.length})
      </Typography>
      <Stack direction="row" flexWrap="wrap" gap={0.5}>
        {children.map((child) => (
          <Chip
            key={child.id}
            label={child.name}
            size="small"
            variant="outlined"
            onClick={() => navigate(`/agents/${child.id}`)}
            sx={{ cursor: "pointer" }}
          />
        ))}
      </Stack>
    </Stack>
  );
}
