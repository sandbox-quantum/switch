import ArrowBack from "@mui/icons-material/ArrowBack";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  type AgentDetail,
  type AgentRoomMembership,
  type AgentSessionDetail,
  type AgentSummary,
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
import { extractDefaults, renderOptionFields } from "./optionFields";

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
  const { user } = useAuth();
  const { data: agent, loading, error, refetch } = useAgent(agentId);

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

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <IconButton onClick={() => navigate("/agents")} size="small">
          <ArrowBack />
        </IconButton>
        <Typography variant="h5" sx={{ flexGrow: 1 }}>
          {agent.name}
        </Typography>
        <Chip label={agent.connector_type} size="small" variant="outlined" />
        {agent.connection_model && (
          <Chip
            label={titleCase(agent.connection_model)}
            size="small"
            color="info"
            variant="outlined"
          />
        )}
      </Stack>

      <Stack spacing={4}>
        <InfoSection agent={agent} />
        <Divider />
        <CapabilitiesSection agent={agent} />
        {agent.known_agent_type && (
          <>
            <Divider />
            <OptionsSection
              agent={agent}
              canEdit={isOwner}
              onUpdated={refetch}
            />
          </>
        )}
        <Divider />
        <AddressingPolicySection
          agent={agent}
          canEdit={isOwner}
          onUpdated={refetch}
        />
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
  const task = (profile.task_protocol ?? {}) as Record<string, unknown>;
  return (
    <Stack spacing={1}>
      <Typography variant="overline" sx={{ color: "text.secondary", display: "block" }}>
        Capabilities
      </Typography>
      <InfoLine
        label="Message exchange"
        value={boolLabel(profile.message_exchange)}
      />
      <InfoLine label="Can delegate" value={boolLabel(task.can_delegate)} />
      <InfoLine label="Can accept tasks" value={boolLabel(task.can_accept)} />
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
              Only the agent's owner can edit these options.
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

function SessionsSection({ sessions }: { sessions: AgentSessionDetail[] }) {
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
        {session.room_name ?? (session.room_id ? session.room_id : "Room-agnostic")}
      </Typography>
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
