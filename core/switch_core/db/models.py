import uuid

from sqlalchemy import (
    DDL,
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    LargeBinary,
    Table,
    Text,
    UniqueConstraint,
    event,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, declared_attr, mapped_column

from switch_core.db.base import Base
from switch_core.db.notify_ddl import (
    CREATE_NOTIFY_FUNCTION,
    CREATE_NOTIFY_TRIGGER,
    DROP_NOTIFY_TRIGGER,
)
from switch_core.db.rls_ddl import attach_row_level_security
from switch_core.db.tenant_lookup import attach_tenant_lookups
from switch_core.tenant_context import current_tenant_id


def _uuid() -> str:
    return str(uuid.uuid4())


# ── Tenants ─────────────────────────────────────────────────────────────────


class Tenant(Base):
    """The top-level customer boundary every scoped table hangs off.

    Deliberately minimal: no `plan`, `status` or `deleted_at`. A later phase
    adds plans and deletion; a `deleted_at` that nothing honours yet would
    read as a guarantee the code does not make.
    """

    __tablename__ = "tenants"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    slug: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class TenantMember(Base):
    """A user's membership in a tenant, and their role within it.

    Membership is a row, not a column on the user: one login may belong to
    several tenants. `role` is a checked string rather than an enum type,
    matching how `users.role` is already stored — a later phase gives these
    roles meaning; this one only records them.
    """

    __tablename__ = "tenant_members"
    __table_args__ = (
        CheckConstraint(
            "role IN ('owner', 'admin', 'member')", name="ck_tenant_members_role"
        ),
    )

    tenant_id: Mapped[str] = mapped_column(
        Text, ForeignKey("tenants.id"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(Text, ForeignKey("users.id"), primary_key=True)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# The fixed id of the one tenant that exists before a second is ever onboarded.
# Written into the migration verbatim rather than read from config, so a later
# edit to `SwitchConfig.tenant_id` can never desync from the row it names.
TENANT_ZERO_ID = "00000000-0000-0000-0000-000000000000"


class TenantNotBoundError(RuntimeError):
    """A scoped row was constructed with no tenant bound to write it under.

    Raised from Python, before the row ever reaches the database, so the
    failure points at the write that forgot to bind rather than at whatever
    row-level-security error Postgres would otherwise raise first. There is no
    longer any such thing as a cross-tenant write: work that spans tenants
    enumerates them through `db/tenant_lookup.py` and then binds each in turn,
    so every write has a tenant by the time it is constructed.
    """


def require_tenant_id() -> str:
    """The tenant bound to this unit of work, raising when nothing is bound.

    The Python-side default on every scoped column, and the answer for the one
    store whose primary key includes the tenant and so has to name it in a
    `session.get` (`ReferenceTypeStore`). Named after the SQL function of the
    same name in `db/rls_ddl.py` because it is the same rule on the other side
    of the wire, and it fails the same way.

    This used to prefer the bound tenant and fall back to tenant zero. That
    fallback is gone: with the row-level-security policies in place, a write
    into tenant zero on behalf of a caller who forgot to bind is not a safe
    default any more — it is a write into a real tenant that happens to be
    wrong the day a second one exists, and `with check` cannot tell it apart
    from a write tenant zero actually intended. Every writer is expected to
    bind one by now: the long-lived background tasks unbind deliberately
    (`switch_core.tenant_context.no_tenant`) and then bind the tenant of the
    row they are about to act on before they act on it, and the raw-session
    inventory in `tests/switch_core/db/test_tenant_exemption_allowlist.py`
    pins which modules may still open a session with nothing bound at all.
    A write reached from one of those without an explicit `tenant_id` is
    exactly the gap this now refuses to paper over.
    """
    tenant_id = current_tenant_id()
    if tenant_id is None:
        raise TenantNotBoundError(
            "no tenant is bound to this session; pass tenant_id explicitly "
            "if this write is genuinely cross-tenant (system seeding), or "
            "bind one before writing otherwise"
        )
    return tenant_id


class TenantScoped:
    """Mixin carrying the tenant column shared by every per-tenant table.

    The foreign key is named explicitly (`fk_<table>_tenant`) rather than left
    for the dialect to default, because `declared_attr` gives each subclass
    its own column and an unnamed constraint would default to
    `<table>_tenant_id_fkey` — a different name than the migration gives the
    same constraint, which would make a schema built by `create_all` disagree
    with one built by Alembic and break the migration's `downgrade` against
    the former.
    """

    @declared_attr
    def tenant_id(cls) -> Mapped[str]:  # noqa: N805 - SQLAlchemy convention
        return mapped_column(
            Text,
            ForeignKey(
                "tenants.id",
                name=f"fk_{cls.__tablename__}_tenant",  # type: ignore[attr-defined]
            ),
            nullable=False,
            default=require_tenant_id,
        )


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


# An OIDC login matches an account on email case-insensitively (CHOO-2624):
# the IdP and the person typing a password don't reliably agree on casing for
# the same mailbox, so a case-sensitive compare would silently defeat the
# "same account" guarantee. Backs UserStore.get_by_email's lower() compare.
Index("ix_users_email_lower", func.lower(User.email))


class OidcIdentity(Base):
    """A verified IdP identity linked to a user (CHOO-2624).

    One row per linked ``(iss, sub)``, unique so a subject can never bind to
    more than one account. A user may hold several — accounts are keyed on
    verified email, not on login method, so a password sign-up that later
    signs in with an IdP sharing its email gets this identity added to the
    same account rather than a second one.

    ``iss`` is nullable only for rows migrated from a pre-CHOO-2624 login that
    predates the issuer being tracked at all (``oidc_sub`` stored alone); the
    application never writes a NULL issuer itself. Such a row still matches on
    ``sub`` alone and has its issuer backfilled on the next login, same as
    before this identity had its own table. ``UNIQUE(iss, sub)`` does not
    constrain these rows at all — Postgres treats every NULL as distinct from
    every other NULL — so ``ix_oidc_identities_sub_null_iss`` separately
    enforces at most one NULL-issuer row per ``sub``; without it two different
    users could each hold one for the same ``sub``, and which one a login
    resolved to would depend on row order, silently annexing one account and
    orphaning the other.

    Matching a legacy row on ``sub`` alone, with no issuer or email in the
    comparison at all, is only safe because a deployment has exactly one
    configured issuer (``gateway_oidc_issuer_url``) today. The moment a second
    issuer exists — a later multi-tenancy phase — two different real-world
    identities could share the same subject string, and a legacy row would
    resolve to whichever one asserts it first regardless of which issuer
    actually owns it. Re-verify or purge sub-only rows before a deployment is
    ever configured with more than one issuer.
    """

    __tablename__ = "oidc_identities"
    __table_args__ = (
        UniqueConstraint("iss", "sub", name="uq_oidc_identities_iss_sub"),
        Index("ix_oidc_identities_sub", "sub"),
        Index(
            "ix_oidc_identities_sub_null_iss",
            "sub",
            unique=True,
            postgresql_where=text("iss IS NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(Text, ForeignKey("users.id"), nullable=False)
    iss: Mapped[str | None] = mapped_column(Text, nullable=True)
    sub: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── API Keys ─────────────────────────────────────────────────────────────────


class ApiKey(TenantScoped, Base):
    __tablename__ = "api_keys"
    __table_args__ = (
        UniqueConstraint("id", "tenant_id", name="uq_api_keys_id_tenant"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(Text, ForeignKey("users.id"), nullable=False)
    # Global on purpose: bearer auth resolves the hash before a tenant is
    # known, so it cannot be scoped by one.
    key_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    encrypted_key: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Clients ────────────────────────────────────────────────────────────────────


class Client(TenantScoped, Base):
    __tablename__ = "clients"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "matrix_user_id", name="uq_clients_tenant_matrix_user_id"
        ),
        UniqueConstraint("id", "tenant_id", name="uq_clients_id_tenant"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    matrix_user_id: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ClientRoom(TenantScoped, Base):
    __tablename__ = "client_rooms"
    __table_args__ = (
        ForeignKeyConstraint(
            ["tenant_id", "client_id"],
            ["clients.tenant_id", "clients.id"],
            name="fk_client_rooms_client",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_client_rooms_room",
        ),
    )

    client_id: Mapped[str] = mapped_column(Text, primary_key=True)
    room_id: Mapped[str] = mapped_column(Text, primary_key=True)
    joined_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Agents ─────────────────────────────────────────────────────────────────────


class Agent(TenantScoped, Base):
    __tablename__ = "agents"
    __table_args__ = (
        Index("ix_agents_parent_agent_id", "parent_agent_id"),
        UniqueConstraint("tenant_id", "name", name="uq_agents_tenant_name"),
        UniqueConstraint("id", "tenant_id", name="uq_agents_id_tenant"),
        ForeignKeyConstraint(
            ["tenant_id", "client_id"],
            ["clients.tenant_id", "clients.id"],
            name="fk_agents_client",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "api_key_id"],
            ["api_keys.tenant_id", "api_keys.id"],
            name="fk_agents_api_key",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "parent_agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agents_parent_agent",
            ondelete="SET NULL (parent_agent_id)",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    # Absolute https URL of the agent's icon (CHOO-2171). Switch stores the
    # link, never image bytes: whatever produces the picture — a generated-
    # avatar service, the operator's own host — is the client's concern. NULL
    # means no icon was chosen, and the display layer supplies the fallback, so
    # that fallback can change without touching stored rows.
    icon_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Human-readable name shown to people ("Switch Dev") next to the machine
    # identifier `name` carries ("switchdev"). NULL means none was chosen and
    # the display layer falls back to `name`. Never the Matrix client display
    # name: that stays the identifier, because it is what bridges match on to
    # recognise an agent's own echo.
    display_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    agent_type: Mapped[str] = mapped_column(Text, nullable=False)
    connector_type: Mapped[str] = mapped_column(Text, nullable=False)
    integration_profile: Mapped[dict] = mapped_column(JSONB, nullable=False)
    client_id: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    # Indexed because bearer-token auth resolves the key row and then looks the
    # agent up by this column on every authenticated request, heartbeats
    # included — without it that is a sequential scan per beat.
    api_key_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    owner_id: Mapped[str | None] = mapped_column(
        Text, ForeignKey("users.id"), nullable=True
    )
    # When set, this agent is a child of another agent — used for Claude Code
    # subagents (`.claude/agents/*.md`) brought into Switch under the user's
    # main Claude Code agent. NULL for ordinary top-level agents. ON DELETE
    # SET NULL so deleting a parent orphans its children rather than removing
    # them (they keep their own identity, rooms, and history).
    parent_agent_id: Mapped[str | None] = mapped_column(Text, nullable=True)
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


class Tool(TenantScoped, Base):
    __tablename__ = "tools"
    __table_args__ = (
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_tools_agent",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    agent_id: Mapped[str] = mapped_column(Text, nullable=False)
    args_schema: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Models ─────────────────────────────────────────────────────────────────────


class Model(TenantScoped, Base):
    __tablename__ = "models"
    __table_args__ = (
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_models_agent",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    agent_id: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Skills ─────────────────────────────────────────────────────────────────────


agent_skills = Table(
    "agent_skills",
    Base.metadata,
    Column(
        "tenant_id",
        Text,
        ForeignKey("tenants.id", name="fk_agent_skills_tenant"),
        nullable=False,
        default=require_tenant_id,
    ),
    Column("agent_id", Text, primary_key=True),
    Column("skill_id", Text, primary_key=True),
    ForeignKeyConstraint(
        ["tenant_id", "agent_id"],
        ["agents.tenant_id", "agents.id"],
        name="fk_agent_skills_agent",
    ),
    ForeignKeyConstraint(
        ["tenant_id", "skill_id"],
        ["skills.tenant_id", "skills.id"],
        name="fk_agent_skills_skill",
    ),
)


class Skill(TenantScoped, Base):
    __tablename__ = "skills"
    __table_args__ = (
        UniqueConstraint("id", "tenant_id", name="uq_skills_id_tenant"),
        ForeignKeyConstraint(
            ["tenant_id", "owner_agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_skills_owner_agent",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    visibility: Mapped[str] = mapped_column(Text, nullable=False)
    owner_agent_id: Mapped[str | None] = mapped_column(Text, nullable=True)
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
    Column(
        "tenant_id",
        Text,
        ForeignKey("tenants.id", name="fk_room_agents_tenant"),
        nullable=False,
        default=require_tenant_id,
    ),
    Column("room_id", Text, primary_key=True),
    Column("agent_id", Text, primary_key=True),
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
    ForeignKeyConstraint(
        ["tenant_id", "room_id"],
        ["rooms.tenant_id", "rooms.id"],
        name="fk_room_agents_room",
    ),
    ForeignKeyConstraint(
        ["tenant_id", "agent_id"],
        ["agents.tenant_id", "agents.id"],
        name="fk_room_agents_agent",
    ),
)

room_skills = Table(
    "room_skills",
    Base.metadata,
    Column(
        "tenant_id",
        Text,
        ForeignKey("tenants.id", name="fk_room_skills_tenant"),
        nullable=False,
        default=require_tenant_id,
    ),
    Column("room_id", Text, primary_key=True),
    Column("skill_id", Text, primary_key=True),
    ForeignKeyConstraint(
        ["tenant_id", "room_id"],
        ["rooms.tenant_id", "rooms.id"],
        name="fk_room_skills_room",
    ),
    ForeignKeyConstraint(
        ["tenant_id", "skill_id"],
        ["skills.tenant_id", "skills.id"],
        name="fk_room_skills_skill",
    ),
)


class Room(TenantScoped, Base):
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
        # group_id is a foreign key with no index, so listing rooms by group
        # and the ON DELETE SET NULL when a group is removed both scan the
        # table. Mirrors ix_agents_parent_agent_id.
        Index("ix_rooms_group_id", "group_id"),
        UniqueConstraint(
            "tenant_id", "matrix_room_id", name="uq_rooms_tenant_matrix_room_id"
        ),
        UniqueConstraint("id", "tenant_id", name="uq_rooms_id_tenant"),
        ForeignKeyConstraint(
            ["tenant_id", "bridge_id"],
            ["collaboration_bridges.tenant_id", "collaboration_bridges.id"],
            name="fk_rooms_bridge",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "group_id"],
            ["room_groups.tenant_id", "room_groups.id"],
            name="fk_rooms_group",
            ondelete="SET NULL (group_id)",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    matrix_room_id: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    bridge_id: Mapped[str | None] = mapped_column(Text, nullable=True)
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
    group_id: Mapped[str | None] = mapped_column(Text, nullable=True)
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


class RoomGroup(TenantScoped, Base):
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
        UniqueConstraint("id", "tenant_id", name="uq_room_groups_id_tenant"),
        ForeignKeyConstraint(
            ["tenant_id", "parent_group_id"],
            ["room_groups.tenant_id", "room_groups.id"],
            name="fk_room_groups_parent_group",
            ondelete="SET NULL (parent_group_id)",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    color: Mapped[str | None] = mapped_column(Text, nullable=True)
    parent_group_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Room Links ────────────────────────────────────────────────────────────────


class RoomLink(TenantScoped, Base):
    """Directed pointer from one room to another, with a free-text label.

    A row represents a one-way link `source_room_id → target_room_id`. The pair
    is unique (composite PK). Both sides cascade-delete: when either room is
    removed, the link goes with it.
    """

    __tablename__ = "room_links"
    __table_args__ = (
        CheckConstraint("source_room_id <> target_room_id", name="room_links_no_self"),
        ForeignKeyConstraint(
            ["tenant_id", "source_room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_room_links_source_room",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "target_room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_room_links_target_room",
            ondelete="CASCADE",
        ),
    )

    source_room_id: Mapped[str] = mapped_column(Text, primary_key=True)
    target_room_id: Mapped[str] = mapped_column(Text, primary_key=True)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Tasks ──────────────────────────────────────────────────────────────────────


class Task(TenantScoped, Base):
    __tablename__ = "tasks"
    __table_args__ = (
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_tasks_room",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "requester_agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_tasks_requester_agent",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "performer_agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_tasks_performer_agent",
            ondelete="CASCADE",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    room_id: Mapped[str] = mapped_column(Text, nullable=False)
    requester_agent_id: Mapped[str] = mapped_column(Text, nullable=False)
    performer_agent_id: Mapped[str] = mapped_column(Text, nullable=False)
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
    Column(
        "tenant_id",
        Text,
        ForeignKey("tenants.id", name="fk_room_references_tenant"),
        nullable=False,
        default=require_tenant_id,
    ),
    Column("room_id", Text, primary_key=True),
    Column("reference_id", Text, primary_key=True),
    ForeignKeyConstraint(
        ["tenant_id", "room_id"],
        ["rooms.tenant_id", "rooms.id"],
        name="fk_room_references_room",
    ),
    ForeignKeyConstraint(
        ["tenant_id", "reference_id"],
        ["references.tenant_id", "references.id"],
        name="fk_room_references_reference",
    ),
)

room_documents = Table(
    "room_documents",
    Base.metadata,
    Column(
        "tenant_id",
        Text,
        ForeignKey("tenants.id", name="fk_room_documents_tenant"),
        nullable=False,
        default=require_tenant_id,
    ),
    Column("room_id", Text, primary_key=True),
    Column("document_id", Text, primary_key=True),
    ForeignKeyConstraint(
        ["tenant_id", "room_id"],
        ["rooms.tenant_id", "rooms.id"],
        name="fk_room_documents_room",
    ),
    ForeignKeyConstraint(
        ["tenant_id", "document_id"],
        ["documents.tenant_id", "documents.id"],
        name="fk_room_documents_document",
    ),
)


class Reference(TenantScoped, Base):
    __tablename__ = "references"
    __table_args__ = (
        UniqueConstraint("id", "tenant_id", name="uq_references_id_tenant"),
    )

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


class ReferenceType(TenantScoped, Base):
    """A customer-defined reference type slug.

    No surrogate `id`: the natural key is `(tenant_id, type)`, so `tenant_id`
    joins the primary key directly here rather than through the `TenantScoped`
    default alone — a type slug may collide across tenants the way `agents.name`
    does. Nothing references this table by foreign key, so it is also the one
    scoped table with no `unique (id, tenant_id)`.
    """

    __tablename__ = "reference_types"

    tenant_id: Mapped[str] = mapped_column(
        Text,
        ForeignKey("tenants.id", name="fk_reference_types_tenant"),
        primary_key=True,
        default=require_tenant_id,
    )
    type: Mapped[str] = mapped_column(Text, primary_key=True)
    owner_id: Mapped[str] = mapped_column(Text, ForeignKey("users.id"), nullable=False)
    read_visibility: Mapped[str] = mapped_column(Text, nullable=False)
    write_visibility: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    instructions: Mapped[str] = mapped_column(Text, nullable=False)
    value_hint: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Document(TenantScoped, Base):
    __tablename__ = "documents"
    __table_args__ = (
        Index(
            "uq_documents_room_name",
            "room_id",
            "name",
            unique=True,
            postgresql_where=text("room_id IS NOT NULL"),
        ),
        UniqueConstraint("id", "tenant_id", name="uq_documents_id_tenant"),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_documents_room",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "created_by_agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_documents_created_by_agent",
            ondelete="SET NULL (created_by_agent_id)",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    owner_id: Mapped[str | None] = mapped_column(
        Text, ForeignKey("users.id"), nullable=True
    )
    room_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_agent_id: Mapped[str | None] = mapped_column(Text, nullable=True)
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
    Column(
        "tenant_id",
        Text,
        ForeignKey("tenants.id", name="fk_room_packages_tenant"),
        nullable=False,
        default=require_tenant_id,
    ),
    Column("room_id", Text, primary_key=True),
    Column("package_id", Text, primary_key=True),
    ForeignKeyConstraint(
        ["tenant_id", "room_id"],
        ["rooms.tenant_id", "rooms.id"],
        name="fk_room_packages_room",
    ),
    ForeignKeyConstraint(
        ["tenant_id", "package_id"],
        ["packages.tenant_id", "packages.id"],
        name="fk_room_packages_package",
    ),
)

package_references = Table(
    "package_references",
    Base.metadata,
    Column(
        "tenant_id",
        Text,
        ForeignKey("tenants.id", name="fk_package_references_tenant"),
        nullable=False,
        default=require_tenant_id,
    ),
    Column("package_id", Text, primary_key=True),
    Column("reference_id", Text, primary_key=True),
    ForeignKeyConstraint(
        ["tenant_id", "package_id"],
        ["packages.tenant_id", "packages.id"],
        name="fk_package_references_package",
    ),
    ForeignKeyConstraint(
        ["tenant_id", "reference_id"],
        ["references.tenant_id", "references.id"],
        name="fk_package_references_reference",
    ),
)

package_documents = Table(
    "package_documents",
    Base.metadata,
    Column(
        "tenant_id",
        Text,
        ForeignKey("tenants.id", name="fk_package_documents_tenant"),
        nullable=False,
        default=require_tenant_id,
    ),
    Column("package_id", Text, primary_key=True),
    Column("document_id", Text, primary_key=True),
    ForeignKeyConstraint(
        ["tenant_id", "package_id"],
        ["packages.tenant_id", "packages.id"],
        name="fk_package_documents_package",
    ),
    ForeignKeyConstraint(
        ["tenant_id", "document_id"],
        ["documents.tenant_id", "documents.id"],
        name="fk_package_documents_document",
    ),
)


class Package(TenantScoped, Base):
    __tablename__ = "packages"
    __table_args__ = (
        UniqueConstraint("id", "tenant_id", name="uq_packages_id_tenant"),
    )

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


class CollaborationBridge(TenantScoped, Base):
    __tablename__ = "collaboration_bridges"
    __table_args__ = (
        # The bridge new rooms land on when no bridge is named. At most one row
        # per tenant may be true; this partial unique index is what actually
        # enforces that, so concurrent writers cannot produce two defaults.
        Index(
            "ix_collaboration_bridges_single_default",
            "tenant_id",
            unique=True,
            postgresql_where=text("is_default"),
        ),
        UniqueConstraint("id", "tenant_id", name="uq_collaboration_bridges_id_tenant"),
        ForeignKeyConstraint(
            ["tenant_id", "client_id"],
            ["clients.tenant_id", "clients.id"],
            name="fk_collaboration_bridges_client",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    connection_config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    client_id: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    agent_greetings_enabled: Mapped[bool] = mapped_column(
        Boolean, server_default="true", nullable=False
    )
    # Whether an operator permits this connection to create channels on the
    # platform. Only ever narrows what the platform allows: a bridge whose
    # adapter reports `supports_channel_creation = False` cannot be granted it
    # by setting this true, so the effective answer is the two ANDed together.
    # Kept per connection rather than per type because withholding it is a
    # deployment's decision — the bot may hold no such permission, or the
    # organisation may not want rooms appearing from Switch.
    channel_creation_enabled: Mapped[bool] = mapped_column(
        Boolean, server_default="true", nullable=False
    )
    is_default: Mapped[bool] = mapped_column(
        Boolean, server_default="false", nullable=False
    )
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Server-Side Connectors ────────────────────────────────────────────────────


class ServerConnector(TenantScoped, Base):
    __tablename__ = "server_connectors"
    __table_args__ = (
        ForeignKeyConstraint(
            ["tenant_id", "api_key_id"],
            ["api_keys.tenant_id", "api_keys.id"],
            name="fk_server_connectors_api_key",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    connection_config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    api_key_id: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── External Users ─────────────────────────────────────────────────────────────


class ExternalUser(TenantScoped, Base):
    __tablename__ = "external_users"
    __table_args__ = (
        UniqueConstraint("bridge_id", "external_user_id"),
        UniqueConstraint("id", "tenant_id", name="uq_external_users_id_tenant"),
        ForeignKeyConstraint(
            ["tenant_id", "bridge_id"],
            ["collaboration_bridges.tenant_id", "collaboration_bridges.id"],
            name="fk_external_users_bridge",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "client_id"],
            ["clients.tenant_id", "clients.id"],
            name="fk_external_users_client",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    bridge_id: Mapped[str] = mapped_column(Text, nullable=False)
    external_user_id: Mapped[str] = mapped_column(Text, nullable=False)
    external_username: Mapped[str] = mapped_column(Text, nullable=False)
    client_id: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ExternalUserClaim(TenantScoped, Base):
    """A Switch user's claim that a platform account is theirs (CHOO-2137).

    Deliberately many-to-many rather than a single owner per account: an
    exclusive claim would let whoever claimed first keep everyone else from
    ever being recognised on that account, which is a quiet way to break
    someone. Several Switch users may claim the same account, and an
    owner-scoped rule is satisfied when the agent's owner is among them.

    An account with no claim at all satisfies no owner rule — unclaimed is
    not "trusted by default".
    """

    __tablename__ = "external_user_claims"
    __table_args__ = (
        Index("ix_external_user_claims_user_id", "user_id"),
        ForeignKeyConstraint(
            ["tenant_id", "external_user_id"],
            ["external_users.tenant_id", "external_users.id"],
            name="fk_external_user_claims_external_user",
            ondelete="CASCADE",
        ),
    )

    external_user_id: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        Text,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Agent Sessions ────────────────────────────────────────────────────────────


class AgentSession(TenantScoped, Base):
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
        Index("ix_agent_sessions_agent_room", "agent_id", "room_id"),
        Index("ix_agent_sessions_transport_session_id", "transport_session_id"),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_sessions_agent",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_agent_sessions_room",
            ondelete="CASCADE",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    agent_id: Mapped[str] = mapped_column(Text, nullable=False)
    room_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    transport_session_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    lifecycle: Mapped[str] = mapped_column(Text, nullable=False)
    last_seen_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class AgentRuntimeState(TenantScoped, Base):
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
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_runtime_states_agent",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_agent_runtime_states_room",
            ondelete="CASCADE",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    agent_id: Mapped[str] = mapped_column(Text, nullable=False)
    room_id: Mapped[str] = mapped_column(Text, nullable=False)
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


class RoomRole(TenantScoped, Base):
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
        UniqueConstraint("id", "tenant_id", name="uq_room_roles_id_tenant"),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_room_roles_room",
            ondelete="CASCADE",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    room_id: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    instructions: Mapped[str] = mapped_column(Text, nullable=False)
    exclusive: Mapped[bool] = mapped_column(
        Boolean, server_default="false", nullable=False
    )
    eligibility: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class RoleLease(TenantScoped, Base):
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
        ForeignKeyConstraint(
            ["tenant_id", "role_id"],
            ["room_roles.tenant_id", "room_roles.id"],
            name="fk_role_leases_role",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_role_leases_room",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_role_leases_agent",
            ondelete="CASCADE",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    role_id: Mapped[str] = mapped_column(Text, nullable=False)
    room_id: Mapped[str] = mapped_column(Text, nullable=False)
    agent_id: Mapped[str] = mapped_column(Text, nullable=False)
    transport_session_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    acquired_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_seen_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Bridge message map ──────────────────────────────────────────────────────────


class BridgeMessageMap(TenantScoped, Base):
    """Durable correlation between a Switch event and its external counterpart.

    One row per bridged message, written in both directions. Powers thread
    bridging (resolving a Switch thread root to its external post and vice
    versa) and the edit/delete sync that previously relied on a volatile
    in-memory dict. Unique in both directions per bridge so either id resolves
    the other.
    """

    __tablename__ = "bridge_message_map"
    __table_args__ = (
        UniqueConstraint("bridge_id", "transport_event_id"),
        UniqueConstraint("bridge_id", "external_post_id"),
        ForeignKeyConstraint(
            ["tenant_id", "bridge_id"],
            ["collaboration_bridges.tenant_id", "collaboration_bridges.id"],
            name="fk_bridge_message_map_bridge",
            ondelete="CASCADE",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    bridge_id: Mapped[str] = mapped_column(Text, nullable=False)
    external_channel_id: Mapped[str] = mapped_column(Text, nullable=False)
    transport_event_id: Mapped[str] = mapped_column(Text, nullable=False)
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


# ── Messages ─────────────────────────────────────────────────────────────────


class Message(TenantScoped, Base):
    """A message as it was sent into a room.

    Written alongside the send to the message bus, which remains the source of
    truth for history until the read path moves here. Rows are therefore a
    parallel record, not yet an authoritative one: a write that fails after a
    successful send leaves a gap, by design, so that a database problem cannot
    make messaging less reliable.

    Every participant in a room is a Switch-owned client, so recording each
    send captures the whole room exactly once — including messages a human
    originates on a bridged platform, which enter through that user's puppet.

    `content` is the full event body as sent. The columns beside it are
    denormalised out of it for querying; for a custom `com.switch.*` event
    they are mostly null and `content` carries everything.
    """

    __tablename__ = "messages"
    __table_args__ = (
        UniqueConstraint("room_id", "seq", name="uq_messages_room_seq"),
        # `seq` orders the room and is what the read path pages on; `sent_at`
        # is what a caller asking for a time window filters by, so it needs an
        # index of its own rather than a scan back along seq.
        Index("ix_messages_room_sent_at", "room_id", "sent_at"),
        Index(
            "ix_messages_thread_root",
            "room_id",
            "thread_root_event_id",
            postgresql_where=text("thread_root_event_id IS NOT NULL"),
        ),
        UniqueConstraint("id", "tenant_id", name="uq_messages_id_tenant"),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_messages_room",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "sender_client_id"],
            ["clients.tenant_id", "clients.id"],
            name="fk_messages_sender_client",
            ondelete="SET NULL (sender_client_id)",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    # Position within the room, from 1, and the cursor the read path pages on.
    # Assigned by MessageStore.create under a per-room lock rather than by a
    # sequence: a sequence hands out numbers when a statement runs, not when it
    # commits, so a row can commit after one with a higher number and a reader
    # paging on `seq > n` would step straight over it. See the store for the
    # argument in full.
    seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    room_id: Mapped[str] = mapped_column(Text, nullable=False)
    # Global on purpose: a random, globally-unique identifier — scoping it
    # buys nothing.
    transport_event_id: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    sender_id: Mapped[str] = mapped_column(Text, nullable=False)
    sender_client_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    sender_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    msgtype: Mapped[str | None] = mapped_column(Text, nullable=True)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    formatted_body: Mapped[str | None] = mapped_column(Text, nullable=True)
    thread_root_event_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    content: Mapped[dict] = mapped_column(JSONB, nullable=False)
    sent_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class MessageAttachment(TenantScoped, Base):
    """A file carried by a message.

    One row per file, so a multi-file send is several rows against one message
    in the order they were sent.
    """

    __tablename__ = "message_attachments"
    __table_args__ = (
        Index("ix_message_attachments_message", "message_id"),
        ForeignKeyConstraint(
            ["tenant_id", "message_id"],
            ["messages.tenant_id", "messages.id"],
            name="fk_message_attachments_message",
            ondelete="CASCADE",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    message_id: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    uri: Mapped[str] = mapped_column(Text, nullable=False)
    filename: Mapped[str | None] = mapped_column(Text, nullable=True)
    mimetype: Mapped[str | None] = mapped_column(Text, nullable=True)
    size: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class DeliveryCursor(TenantScoped, Base):
    """How far one agent has been delivered in one room.

    The cursor it replaces lived in memory in the event buffer, so a restart
    resumed from wherever that buffer happened to be rather than from what the
    agent had actually been given. Persisting it makes "what has this agent
    seen" outlive the process, which is what lets delivery be driven from the
    table instead of from a live connection.

    `last_seq` is a position in the room, not a count: `seq` is a per-room
    total order, so "everything up to n" is unambiguous and re-reading from it
    is idempotent. It is only ever advanced, never rewound — a cursor that
    could go backwards would redeliver, and a redelivered message is
    indistinguishable to a reader from a new one.
    """

    __tablename__ = "delivery_cursors"
    __table_args__ = (
        UniqueConstraint("agent_id", "room_id", name="uq_delivery_cursors_agent_room"),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_delivery_cursors_agent",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_delivery_cursors_room",
            ondelete="CASCADE",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    agent_id: Mapped[str] = mapped_column(Text, nullable=False)
    room_id: Mapped[str] = mapped_column(Text, nullable=False)
    last_seq: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    updated_at: Mapped[str] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class MediaBlob(TenantScoped, Base):
    """The bytes behind an attachment.

    Media used to live in the homeserver's own store, reached by an opaque
    handle that travelled on the message. The handle is still opaque and still
    travels on the message; only what is behind it changed. Callers must not
    parse `uri` — it is a key, and the store behind it is free to become object
    storage without the protocol noticing.

    `bytea` rather than a large object: attachments are capped
    (`agent_media_max_bytes`, 20MB by default) and are written and read whole,
    which is exactly what TOAST handles well and what large objects add
    lifecycle problems to. A blob that would not fit is rejected at the edge,
    loudly, as it already is.

    Rows are not reference-counted against the attachments pointing at them.
    Deleting a room deletes its messages; the bytes it referenced are then
    unreferenced and a later sweep can find them by that. Cascading from the
    attachment instead would delete the bytes of a file that two messages
    quote.

    Scoped although nothing references it by foreign key: it holds attachment
    bytes reached by an opaque URI, and an unguessable identifier is not an
    isolation boundary.
    """

    __tablename__ = "media_blobs"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    uri: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    content_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    filename: Mapped[str | None] = mapped_column(Text, nullable=True)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    data: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# `create_all` builds the schema for tests; the trigger has to come with it or
# the delivery tests would exercise a table that announces nothing. Real
# databases get the same DDL from a migration.
event.listen(
    Message.__table__,
    "after_create",
    DDL(CREATE_NOTIFY_FUNCTION).execute_if(dialect="postgresql"),
)
event.listen(
    Message.__table__,
    "after_create",
    DDL(CREATE_NOTIFY_TRIGGER).execute_if(dialect="postgresql"),
)
event.listen(
    Message.__table__,
    "before_drop",
    DDL(DROP_NOTIFY_TRIGGER).execute_if(dialect="postgresql"),
)

# Same reasoning as the notify trigger above: `create_all` has to build the
# row-level-security policies too, or the isolation test would pass against a
# schema that has none. See `db/rls_ddl.py` for the DDL and why it takes this
# shape; a migration carries its own frozen copy for the same reason the
# notify trigger's migration does.
attach_row_level_security(Base.metadata)

# And the seven functions that are exempt from those policies, on the same
# reasoning again: a restricted role cannot boot without them, so a schema
# `create_all` built without them is not the schema the server runs against.
# After the tables, not before — see `db/tenant_lookup.py`.
attach_tenant_lookups(Base.metadata)
