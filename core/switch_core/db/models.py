import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Table,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from switch_core.db.base import Base


def _uuid() -> str:
    return str(uuid.uuid4())


# ── Users ──────────────────────────────────────────────────────────────────────


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    email: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    # Nullable: OIDC-provisioned users have no local password until one is set.
    password_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── API Keys ─────────────────────────────────────────────────────────────────


class ApiKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(Text, ForeignKey("users.id"), nullable=False)
    key_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    encrypted_key: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Clients ────────────────────────────────────────────────────────────────────


class Client(Base):
    __tablename__ = "clients"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    matrix_user_id: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    password: Mapped[str] = mapped_column(Text, nullable=False)
    device_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    access_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    next_batch_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ClientRoom(Base):
    __tablename__ = "client_rooms"

    client_id: Mapped[str] = mapped_column(
        Text, ForeignKey("clients.id"), primary_key=True
    )
    room_id: Mapped[str] = mapped_column(Text, ForeignKey("rooms.id"), primary_key=True)
    joined_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Agents ─────────────────────────────────────────────────────────────────────


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    agent_type: Mapped[str] = mapped_column(Text, nullable=False)
    connector_type: Mapped[str] = mapped_column(Text, nullable=False)
    integration_profile: Mapped[dict] = mapped_column(JSONB, nullable=False)
    client_id: Mapped[str] = mapped_column(
        Text, ForeignKey("clients.id"), unique=True, nullable=False
    )
    api_key_id: Mapped[str] = mapped_column(
        Text, ForeignKey("api_keys.id"), nullable=False
    )
    owner_id: Mapped[str | None] = mapped_column(
        Text, ForeignKey("users.id"), nullable=True
    )
    # When set, this agent is a child of another agent — used for Claude Code
    # subagents (`.claude/agents/*.md`) brought into Switch under the user's
    # main Claude Code agent. NULL for ordinary top-level agents. ON DELETE
    # SET NULL so deleting a parent orphans its children rather than removing
    # them (they keep their own identity, rooms, and history).
    parent_agent_id: Mapped[str | None] = mapped_column(
        Text, ForeignKey("agents.id", ondelete="SET NULL"), nullable=True
    )
    oauth_client_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Scoped agent-addressing permissions (CHOO-1585). NULL preserves today's
    # open behaviour (anyone may address the agent); a stored policy is a
    # `switch_core.addressing.AddressingPolicy` blob (an allow-list of rules
    # over room / room-group / user / agent). See that module for the model.
    addressing_policy: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Tools ──────────────────────────────────────────────────────────────────────


class Tool(Base):
    __tablename__ = "tools"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    agent_id: Mapped[str] = mapped_column(Text, ForeignKey("agents.id"), nullable=False)
    args_schema: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Models ─────────────────────────────────────────────────────────────────────


class Model(Base):
    __tablename__ = "models"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    agent_id: Mapped[str] = mapped_column(Text, ForeignKey("agents.id"), nullable=False)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Skills ─────────────────────────────────────────────────────────────────────


agent_skills = Table(
    "agent_skills",
    Base.metadata,
    Column("agent_id", Text, ForeignKey("agents.id"), primary_key=True),
    Column("skill_id", Text, ForeignKey("skills.id"), primary_key=True),
)


class Skill(Base):
    __tablename__ = "skills"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    visibility: Mapped[str] = mapped_column(Text, nullable=False)
    owner_agent_id: Mapped[str | None] = mapped_column(
        Text, ForeignKey("agents.id"), nullable=True
    )
    created_by: Mapped[str | None] = mapped_column(
        Text, ForeignKey("users.id"), nullable=True
    )
    package_uri: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Rooms ──────────────────────────────────────────────────────────────────────


room_agents = Table(
    "room_agents",
    Base.metadata,
    Column("room_id", Text, ForeignKey("rooms.id"), primary_key=True),
    Column("agent_id", Text, ForeignKey("agents.id"), primary_key=True),
    Column("last_connected_at", DateTime(timezone=True), nullable=True),
    Column(
        "receives_join_events",
        Boolean,
        nullable=False,
        server_default=text("false"),
    ),
    # Room-scoped alias: `@<alias>` addresses this agent in this room exactly
    # like its real name. Null when the agent has no alias here.
    Column("alias", Text, nullable=True),
)

room_skills = Table(
    "room_skills",
    Base.metadata,
    Column("room_id", Text, ForeignKey("rooms.id"), primary_key=True),
    Column("skill_id", Text, ForeignKey("skills.id"), primary_key=True),
)


class Room(Base):
    __tablename__ = "rooms"
    __table_args__ = (
        # A bridged channel maps to at most one Switch room. Partial so that
        # internal-only rooms (external_channel_id IS NULL) are unconstrained.
        Index(
            "uq_rooms_bridge_external_channel",
            "bridge_id",
            "external_channel_id",
            unique=True,
            postgresql_where=text("external_channel_id IS NOT NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    matrix_room_id: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    bridge_id: Mapped[str | None] = mapped_column(
        Text, ForeignKey("collaboration_bridges.id"), nullable=True
    )
    external_channel_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    channel_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    admin_mode: Mapped[bool] = mapped_column(
        Boolean, server_default="false", nullable=False
    )
    instructions: Mapped[str | None] = mapped_column(Text, nullable=True)
    protection_config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    observe_config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_by: Mapped[str | None] = mapped_column(
        Text, ForeignKey("users.id"), nullable=True
    )
    group_id: Mapped[str | None] = mapped_column(
        Text, ForeignKey("room_groups.id", ondelete="SET NULL"), nullable=True
    )
    owner_id: Mapped[str | None] = mapped_column(
        Text, ForeignKey("users.id"), nullable=True
    )
    read_visibility: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="public"
    )
    write_visibility: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="public"
    )
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # When set, the room is archived: hidden from the default active room lists
    # (gateway + agent MCP tools) but otherwise fully intact and retrievable —
    # members, Matrix room, and bridge channel are untouched. NULL = active.
    # Archiving is metadata-only and reversible (unarchive clears this).
    archived_at: Mapped[str | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


# ── Room Groups ─────────────────────────────────────────────────────────────────


class RoomGroup(Base):
    """A named, optionally-nested organizational group for rooms.

    Groups form a tree via the nullable `parent_group_id` self-reference;
    top-level groups have `parent_group_id IS NULL`. A room belongs to at most
    one group (see `Room.group_id`) and that group may sit anywhere in the tree.
    Groups are a navigation/visualization layer only — distinct from directed
    `RoomLink`s.

    Deleting a group does not delete its rooms or child groups: `Room.group_id`
    is `ON DELETE SET NULL` (member rooms become standalone) and child groups
    are reparented in the store layer (promoted toward the root).
    """

    __tablename__ = "room_groups"
    __table_args__ = (
        CheckConstraint("parent_group_id <> id", name="room_groups_no_self_parent"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    color: Mapped[str | None] = mapped_column(Text, nullable=True)
    parent_group_id: Mapped[str | None] = mapped_column(
        Text, ForeignKey("room_groups.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Room Links ────────────────────────────────────────────────────────────────


class RoomLink(Base):
    """Directed pointer from one room to another, with a free-text label.

    A row represents a one-way link `source_room_id → target_room_id`. The pair
    is unique (composite PK). Both sides cascade-delete: when either room is
    removed, the link goes with it.
    """

    __tablename__ = "room_links"
    __table_args__ = (
        CheckConstraint("source_room_id <> target_room_id", name="room_links_no_self"),
    )

    source_room_id: Mapped[str] = mapped_column(
        Text, ForeignKey("rooms.id", ondelete="CASCADE"), primary_key=True
    )
    target_room_id: Mapped[str] = mapped_column(
        Text, ForeignKey("rooms.id", ondelete="CASCADE"), primary_key=True
    )
    label: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Tasks ──────────────────────────────────────────────────────────────────────


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    room_id: Mapped[str] = mapped_column(Text, ForeignKey("rooms.id"), nullable=False)
    requester_agent_id: Mapped[str] = mapped_column(
        Text, ForeignKey("agents.id", ondelete="CASCADE"), nullable=False
    )
    performer_agent_id: Mapped[str] = mapped_column(
        Text, ForeignKey("agents.id", ondelete="CASCADE"), nullable=False
    )
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    updates: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    outcome: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    accepted_at: Mapped[str | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    finalised_at: Mapped[str | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


# ── References & Documents ────────────────────────────────────────────────────


room_references = Table(
    "room_references",
    Base.metadata,
    Column("room_id", Text, ForeignKey("rooms.id"), primary_key=True),
    Column("reference_id", Text, ForeignKey("references.id"), primary_key=True),
)

room_documents = Table(
    "room_documents",
    Base.metadata,
    Column("room_id", Text, ForeignKey("rooms.id"), primary_key=True),
    Column("document_id", Text, ForeignKey("documents.id"), primary_key=True),
)


class Reference(Base):
    __tablename__ = "references"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    owner_id: Mapped[str] = mapped_column(Text, ForeignKey("users.id"), nullable=False)
    read_visibility: Mapped[str] = mapped_column(Text, nullable=False)
    write_visibility: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    instructions: Mapped[str] = mapped_column(Text, nullable=False)
    value: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Document(Base):
    __tablename__ = "documents"
    __table_args__ = (
        Index(
            "uq_documents_room_name",
            "room_id",
            "name",
            unique=True,
            postgresql_where=text("room_id IS NOT NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    owner_id: Mapped[str | None] = mapped_column(
        Text, ForeignKey("users.id"), nullable=True
    )
    room_id: Mapped[str | None] = mapped_column(
        Text, ForeignKey("rooms.id", ondelete="CASCADE"), nullable=True
    )
    created_by_agent_id: Mapped[str | None] = mapped_column(
        Text, ForeignKey("agents.id", ondelete="SET NULL"), nullable=True
    )
    read_visibility: Mapped[str] = mapped_column(Text, nullable=False)
    write_visibility: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    instructions: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Packages ──────────────────────────────────────────────────────────────────


room_packages = Table(
    "room_packages",
    Base.metadata,
    Column("room_id", Text, ForeignKey("rooms.id"), primary_key=True),
    Column("package_id", Text, ForeignKey("packages.id"), primary_key=True),
)

package_references = Table(
    "package_references",
    Base.metadata,
    Column("package_id", Text, ForeignKey("packages.id"), primary_key=True),
    Column("reference_id", Text, ForeignKey("references.id"), primary_key=True),
)

package_documents = Table(
    "package_documents",
    Base.metadata,
    Column("package_id", Text, ForeignKey("packages.id"), primary_key=True),
    Column("document_id", Text, ForeignKey("documents.id"), primary_key=True),
)


class Package(Base):
    __tablename__ = "packages"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    owner_id: Mapped[str] = mapped_column(Text, ForeignKey("users.id"), nullable=False)
    read_visibility: Mapped[str] = mapped_column(Text, nullable=False)
    write_visibility: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    instructions: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Collaboration Bridges ──────────────────────────────────────────────────────


class CollaborationBridge(Base):
    __tablename__ = "collaboration_bridges"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    connection_config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    client_id: Mapped[str] = mapped_column(
        Text, ForeignKey("clients.id"), nullable=False
    )
    status: Mapped[str] = mapped_column(Text, nullable=False)
    agent_greetings_enabled: Mapped[bool] = mapped_column(
        Boolean, server_default="true", nullable=False
    )
    # The bridge new rooms land on when no bridge is named. At most one row may
    # be true; the partial unique index below is what actually enforces that,
    # so concurrent writers cannot produce two defaults.
    is_default: Mapped[bool] = mapped_column(
        Boolean, server_default="false", nullable=False
    )
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index(
            "ix_collaboration_bridges_single_default",
            "is_default",
            unique=True,
            postgresql_where=text("is_default"),
        ),
    )


# ── Server-Side Connectors ────────────────────────────────────────────────────


class ServerConnector(Base):
    __tablename__ = "server_connectors"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    connection_config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    api_key_id: Mapped[str] = mapped_column(
        Text, ForeignKey("api_keys.id"), nullable=False
    )
    status: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── External Users ─────────────────────────────────────────────────────────────


class ExternalUser(Base):
    __tablename__ = "external_users"
    __table_args__ = (UniqueConstraint("bridge_id", "external_user_id"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    bridge_id: Mapped[str] = mapped_column(
        Text, ForeignKey("collaboration_bridges.id"), nullable=False
    )
    external_user_id: Mapped[str] = mapped_column(Text, nullable=False)
    external_username: Mapped[str] = mapped_column(Text, nullable=False)
    client_id: Mapped[str] = mapped_column(
        Text, ForeignKey("clients.id"), nullable=False
    )
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Agent Sessions ────────────────────────────────────────────────────────────


class AgentSession(Base):
    """Tracks agent reachability and MCP-session room bindings.

    Each row carries two independent pieces of state:

    - `lifecycle` + `last_seen_at`: reachability. `'heartbeat'` rows are
      refreshed by poll handlers (always_on, session_addressable) and
      considered live while `last_seen_at` is within the TTL. `'explicit'`
      rows (session_passive) exist only as transport bindings and are not
      used for liveness.
    - `transport_session_id`: the MCP transport currently bound to this
      (agent, room) by `connect_to_room`. Heartbeats never clear it.

    Uniqueness is enforced on `(agent_id, COALESCE(room_id, ''))` so a single
    agent has at most one row per room (and at most one room-agnostic row for
    always_on heartbeats).
    """

    __tablename__ = "agent_sessions"
    __table_args__ = (
        Index(
            "uq_agent_sessions_agent_room",
            text("agent_id"),
            text("coalesce(room_id, '')"),
            unique=True,
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    agent_id: Mapped[str] = mapped_column(
        Text, ForeignKey("agents.id", ondelete="CASCADE"), nullable=False
    )
    room_id: Mapped[str | None] = mapped_column(
        Text, ForeignKey("rooms.id", ondelete="CASCADE"), nullable=True
    )
    transport_session_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    lifecycle: Mapped[str] = mapped_column(Text, nullable=False)
    last_seen_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class AgentRuntimeState(Base):
    """The runtime/liveness state of an agent's session as seen in one room.

    Distinct from `AgentSession` (which tracks *reachability*): this captures
    what the agent's live session is *doing* — `'working'`, `'awaiting-input'`,
    or `'idle'` — derived from the Switch Console-managed Claude Code session and
    surfaced on the room's bridged channel. One row per (agent, room), mirroring
    the `AgentSession` grain, so a state is conceptually tied to that room's
    session: when the session's heartbeat lapses the sweep resets the row to
    `'idle'` so a "working" surface doesn't linger after the session leaves.
    """

    __tablename__ = "agent_runtime_states"
    __table_args__ = (
        UniqueConstraint(
            "agent_id", "room_id", name="uq_agent_runtime_states_agent_room"
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    agent_id: Mapped[str] = mapped_column(
        Text, ForeignKey("agents.id", ondelete="CASCADE"), nullable=False
    )
    room_id: Mapped[str] = mapped_column(
        Text, ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False
    )
    state: Mapped[str] = mapped_column(Text, nullable=False)
    # The switchdash://session deeplink the reporting client (Switch Console) last
    # sent for this (agent, room), so `!status` can surface an on-demand link to
    # the session. Null for agents whose connector doesn't report one.
    deeplink_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Which session-control commands (reset/compact/interrupt) the live session
    # behind this (agent, room) can execute, as reported by its controller
    # (Switch Console) — e.g. {"reset": true, "compact": true, "interrupt": true}.
    # Null when no controller reports capabilities (e.g. a standalone `claude`
    # session), which resolves session_dependent commands to "unsupported".
    control_capabilities: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    updated_at: Mapped[str] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


# ── Room Roles ────────────────────────────────────────────────────────────────


class RoomRole(Base):
    """A first-class, per-room, assumable instruction bundle.

    A role is a named bundle of instructions scoped to a single room, decoupled
    from any specific agent. Any room member may *assume* a role (see
    `RoleLease`) and receive its `instructions` for that session. Roles are the
    forward-compatible home for the future "deterministic rules for rooms" work:
    a role is conceptually a named instruction (and later rule) bundle.

    `exclusive` roles (e.g. "manager") may be held by at most one live agent at
    a time; assuming one acquires a `RoleLease` with a heartbeat that
    auto-releases on disconnect/idle. Non-exclusive roles (e.g. "worker") are
    unrestricted. `eligibility` is a forward-looking hook for ACL-based
    restrictions on who may assume a role — unused (NULL) in v1, where any room
    member may assume any role.
    """

    __tablename__ = "room_roles"
    __table_args__ = (
        UniqueConstraint("room_id", "name", name="uq_room_roles_room_name"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    room_id: Mapped[str] = mapped_column(
        Text, ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    instructions: Mapped[str] = mapped_column(Text, nullable=False)
    exclusive: Mapped[bool] = mapped_column(
        Boolean, server_default="false", nullable=False
    )
    eligibility: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class RoleLease(Base):
    """The current holder of a room-role, with heartbeat-based auto-release.

    A lease records that `agent_id` currently holds `role_id` in `room_id`. A
    lease is *live* while `last_seen_at` is within the lease TTL (see
    `RoomRoleStore.LEASE_TTL`); a stale lease is logically free, so the next
    agent can assume the role without a background reaper.

    Liveness is keyed to the agent's session (room-agnostic): the long-running
    channel process renews the lease on a fast cadence while the session is
    alive, so hopping to another room keeps the seat. One lease per agent is
    enforced by the unique index on `agent_id`; `release_role` (or session death
    + TTL) frees it. `transport_session_id` records which MCP transport assumed
    the role.
    """

    __tablename__ = "role_leases"
    __table_args__ = (
        UniqueConstraint("agent_id", name="uq_role_leases_agent"),
        Index("ix_role_leases_role_id", "role_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    role_id: Mapped[str] = mapped_column(
        Text, ForeignKey("room_roles.id", ondelete="CASCADE"), nullable=False
    )
    room_id: Mapped[str] = mapped_column(
        Text, ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False
    )
    agent_id: Mapped[str] = mapped_column(
        Text, ForeignKey("agents.id", ondelete="CASCADE"), nullable=False
    )
    transport_session_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    acquired_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_seen_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Bridge message map ──────────────────────────────────────────────────────────


class BridgeMessageMap(Base):
    """Durable correlation between a Matrix event and its external counterpart.

    One row per bridged message, written in both directions (Matrix→external
    and external→Matrix). Powers thread bridging (resolving a Matrix thread
    root to its external post and vice versa) and the edit/delete sync that
    previously relied on a volatile in-memory dict. Unique in both directions
    per bridge so either id resolves the other.
    """

    __tablename__ = "bridge_message_map"
    __table_args__ = (
        UniqueConstraint("bridge_id", "matrix_event_id"),
        UniqueConstraint("bridge_id", "external_post_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    bridge_id: Mapped[str] = mapped_column(
        Text, ForeignKey("collaboration_bridges.id", ondelete="CASCADE"), nullable=False
    )
    external_channel_id: Mapped[str] = mapped_column(Text, nullable=False)
    matrix_event_id: Mapped[str] = mapped_column(Text, nullable=False)
    external_post_id: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Feature flags ────────────────────────────────────────────────────────────


class FeatureFlag(Base):
    """Server-global on/off switch keyed by a well-known flag name.

    A row exists only once a flag has been written; an absent row means the
    flag is OFF (its default). Which keys are writable is enforced in the
    application layer (see ``switch_core.feature_flags``), not by the table.
    """

    __tablename__ = "feature_flags"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[str] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
