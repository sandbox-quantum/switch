import uuid
from datetime import datetime
from enum import StrEnum

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
    PrimaryKeyConstraint,
    Sequence,
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
from switch_core.db.session_activity_notify_ddl import (
    CREATE_ACTIVITY_TRIGGER,
    CREATE_APPROVAL_INSERT_TRIGGER,
    CREATE_APPROVAL_STATE_TRIGGER,
    CREATE_SESSION_ACTIVITY_NOTIFY_FUNCTION,
)
from switch_core.db.tenant_lookup import attach_tenant_lookups
from switch_core.tenant_context import current_tenant_id

agent_event_boot_sequence = Sequence(
    "agent_event_boot", metadata=Base.metadata, maxvalue=2097150, cycle=False
)


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
    # Workspaces this person has created through self-service, which is what
    # `GATEWAY_MAX_WORKSPACES_PER_USER` bounds. A count of creations rather
    # than of current ownership, so handing a workspace to someone else does
    # not free an allowance to create another.
    workspaces_created: Mapped[int] = mapped_column(
        Integer, server_default=text("0"), nullable=False
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


class ProviderConnection(TenantScoped, Base):
    __tablename__ = "provider_connections"
    __table_args__ = (
        PrimaryKeyConstraint("tenant_id", "user_id", "provider"),
        CheckConstraint(
            "provider IN ('claude', 'github', 'codex', 'opencode', 'cursor', 'antigravity')",
            name="ck_provider_connections_provider",
        ),
        CheckConstraint(
            "(provider = 'claude' AND kind IN ('api-key', 'setup-token')) OR (provider = 'github' AND kind = 'oauth') OR (provider = 'codex' AND kind IN ('api-key', 'auth-json')) OR (provider = 'cursor' AND kind = 'api-key') OR (provider IN ('opencode', 'antigravity') AND kind = 'auth-json')",
            name="ck_provider_connections_kind",
        ),
    )

    user_id: Mapped[str] = mapped_column(
        Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    encrypted_credential: Mapped[str] = mapped_column(Text, nullable=False)
    verification_status: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="verified"
    )
    verified_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )


class ProviderVerification(TenantScoped, Base):
    __tablename__ = "provider_verifications"
    __table_args__ = (
        PrimaryKeyConstraint("tenant_id", "id"),
        Index(
            "ix_provider_verification_owner",
            "tenant_id",
            "user_id",
            "provider",
            "created_at",
        ),
        Index("ix_provider_verification_state", "tenant_id", "state"),
    )

    id: Mapped[str] = mapped_column(Text, nullable=False)
    user_id: Mapped[str] = mapped_column(
        Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    encrypted_credential: Mapped[str | None] = mapped_column(Text)
    encrypted_token: Mapped[str | None] = mapped_column(Text)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    result: Mapped[bool | None] = mapped_column(Boolean)
    instance_id: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    deadline: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class HostedLaunch(TenantScoped, Base):
    __tablename__ = "hosted_launches"
    __table_args__ = (
        PrimaryKeyConstraint("tenant_id", "id"),
        UniqueConstraint("tenant_id", "name", name="uq_hosted_launch_name"),
        CheckConstraint(
            "state IN ('queued', 'provisioning', 'ready', 'error', 'stopping', 'stopped', 'deleting', 'deleted')",
            name="ck_hosted_launch_state",
        ),
    )

    id: Mapped[str] = mapped_column(Text, nullable=False)
    owner_id: Mapped[str] = mapped_column(Text, ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    spec: Mapped[dict] = mapped_column(JSONB, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False, server_default="queued")
    agent_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    desired_state: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="running"
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    deletion_cleanup: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    sleeping: Mapped[bool] = mapped_column(
        Boolean, server_default="false", nullable=False
    )
    active_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    worker_capability_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    worker_capability_encrypted: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )
    worker_capability_revision: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    relay_seq: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="0"
    )


class GitHubIssuedToken(TenantScoped, Base):
    __tablename__ = "github_issued_tokens"
    __table_args__ = (
        PrimaryKeyConstraint("tenant_id", "id"),
        ForeignKeyConstraint(
            ["tenant_id", "launch_id"],
            ["hosted_launches.tenant_id", "hosted_launches.id"],
        ),
        Index("ix_github_issued_tokens_owner", "tenant_id", "owner_id"),
    )
    id: Mapped[str] = mapped_column(Text, nullable=False)
    owner_id: Mapped[str] = mapped_column(Text, ForeignKey("users.id"), nullable=False)
    launch_id: Mapped[str] = mapped_column(Text, nullable=False)
    launch_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    encrypted_token: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    revoke_requested: Mapped[bool] = mapped_column(Boolean, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False)
    claim_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class HostedOperation(TenantScoped, Base):
    __tablename__ = "hosted_operations"
    __table_args__ = (
        PrimaryKeyConstraint("tenant_id", "id"),
        ForeignKeyConstraint(
            ["tenant_id", "launch_id"],
            ["hosted_launches.tenant_id", "hosted_launches.id"],
            ondelete="CASCADE",
        ),
        CheckConstraint(
            "state IN ('queued', 'claimed', 'applied', 'failed', 'unknown')",
            name="ck_hosted_operation_state",
        ),
    )
    id: Mapped[str] = mapped_column(Text, nullable=False)
    launch_id: Mapped[str] = mapped_column(Text, nullable=False)
    launch_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    session_id: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False, server_default="queued")
    error: Mapped[str | None] = mapped_column(Text)
    claimed_by: Mapped[str | None] = mapped_column(Text)
    claimed_boot_id: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Invitations ────────────────────────────────────────────────────────────────


class Invitation(TenantScoped, Base):
    """A credential that grants membership in a tenant (CHOO-2722).

    `email` is null for a shareable link and set for an invitation addressed
    to one person; nothing at this layer refuses acceptance by a different
    address, which is a decision for whatever accepts the invitation, not for
    the row that describes it.

    `token_hash` is unique across the whole deployment rather than per tenant,
    the same reasoning as `api_keys.key_hash`: accepting an invitation is
    exactly the credential-resolution shape that runs before any tenant is
    bound, so the hash has to be resolvable on its own. `tenant_of_invitation`
    (`db/tenant_lookup.py`) is the lookup that does it. The hash, never the
    token: nothing in this schema, this store, or anything built on either
    holds the plaintext once `InvitationStore.create` has returned it.

    `role` is a checked string rather than an enum type, matching
    `tenant_members.role` — the role an acceptance would grant, not one held
    by anything yet.

    `uses_remaining` and `expires_at` bound how long and how many times the
    token works; `revoked_at` is a third, independent way to stop it early.
    None of the three are optional here — a table that could not expire or be
    revoked would not be a credential, and the design this implements is
    explicit that expiry and revocation are not optional.

    The floor under `uses_remaining` is a constraint rather than a convention
    because the thing it guards against is a lost race, not a typo: two
    concurrent acceptances of a single-use invitation can both read `1` and
    both write `0`, and read-committed will let both commit. `consume`
    (`db/stores/invitation_store.py`) is the decrement that cannot lose that
    race; the constraint is what makes any other decrement fail loudly instead
    of over-granting membership.
    """

    __tablename__ = "invitations"
    __table_args__ = (
        CheckConstraint(
            "role IN ('owner', 'admin', 'member')", name="ck_invitations_role"
        ),
        CheckConstraint(
            "uses_remaining >= 0", name="ck_invitations_uses_remaining_not_negative"
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    email: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Global on purpose, like api_keys.key_hash: accepting an invitation
    # resolves the hash before a tenant is known, so it cannot be scoped by
    # one.
    token_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    uses_remaining: Mapped[int] = mapped_column(Integer, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_by: Mapped[str] = mapped_column(
        Text, ForeignKey("users.id"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
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


# ── Templates ─────────────────────────────────────────────────────────────────


class Template(TenantScoped, Base):
    """A template document held on this server, plus the metadata to find it.

    ``content`` is stored verbatim and never parsed, so a document in a format
    this server does not yet understand still round-trips byte for byte.
    ``kind`` is free text for the same reason: room, group and agent templates
    differ only in a string, not in the schema.

    ``version`` counts revisions of the stored row, incrementing whenever the
    content is replaced. It is not the author's name for a release, and not the
    inert ``version:`` key inside the document — those belong to the format.
    """

    __tablename__ = "templates"
    __table_args__ = (
        # Not widened to include the tenant: an owner belongs to one, so
        # scoping the name to the owner already scopes it to the tenant.
        UniqueConstraint("owner_id", "name", name="uq_templates_owner_name"),
        UniqueConstraint("id", "tenant_id", name="uq_templates_id_tenant"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    owner_id: Mapped[str] = mapped_column(Text, ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    # Who may see and who may change it, as for references and packages
    # (see ``authz.can``). The defaults are a template shared with the
    # workspace and changed by its owner or an admin.
    read_visibility: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="public"
    )
    write_visibility: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="private"
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[str] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
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


# ── Messaging Installs ─────────────────────────────────────────────────────────


class MessagingInstall(TenantScoped, Base):
    """A tenant's installation of the Switch app into one external workspace.

    The difference from `collaboration_bridges` is who supplied the
    credential. A bridge holds a token an operator pasted in, from an app that
    operator registered; an install holds a token *we* were granted, for our
    app, by whoever clicked Add to Slack. Both end up driving the same adapter,
    so this table records only what the install added: which workspace, whose
    token, and what it may do.

    **`(platform, external_workspace_id)` is unique across the whole
    deployment among rows that are still `active`**, and that is the single
    most important line here. Inbound events arrive over one public endpoint
    carrying a workspace id and no tenant, so a workspace claimed by two
    tenants is a message with two possible destinations and no way to choose —
    which is the failure this whole phase exists to make unrepresentable. The
    database decides it rather than a read-then-insert in application code,
    because the check and the write cannot be made atomic from outside.

    It is a *partial* index rather than a plain constraint because an install
    has to be able to end. A customer who removes the app in Slack, or an
    operator who disconnects it here, leaves a row behind — and a row that
    still occupied the workspace would mean nobody could ever install that
    workspace again, including the customer who just removed it. Ending an
    install therefore frees the workspace, and keeps the record of the one
    that ended.

    That index is also the one place a tenant learns something about another:
    claiming a workspace somebody else already holds fails, and the failure
    says so. It is the right answer — the alternative is a silent second claim
    — and what it discloses is that *some* tenant holds a workspace the caller
    was already able to name.

    `status` is `active`, `disconnected` (an operator here ended it) or
    `revoked` (the platform told us it was over). The two endings are recorded
    apart because they call for different things: one is somebody's decision
    and the other is news, and an operator looking at a bridge that stopped
    working needs to know which.

    `bridge_id` is nullable because the install row is written before anything
    is built on it, and because removing a bridge should not force the
    credential to be thrown away and re-granted. A null there means the
    install is recorded and not yet serving.

    `encrypted_bot_token` uses the same key as every other credential this
    schema stores (`crypto.encrypt_token` over the configured secret), so it
    is protected against a stolen dump and not against a compromised process.
    A per-tenant key is a stronger boundary and a later decision. It is
    nullable so that an install which has ended can keep its record without
    keeping its secret: the token is worthless by then, and a worthless
    credential still reads like a credential to whoever finds the dump.

    `scopes` is the platform's own spelling of what was granted, stored
    verbatim rather than parsed into a list — a scope string that means
    nothing to us is still the thing to show an operator asking why a call was
    refused.
    """

    __tablename__ = "messaging_installs"
    __table_args__ = (
        Index(
            "uq_messaging_installs_workspace",
            "platform",
            "external_workspace_id",
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
        UniqueConstraint("id", "tenant_id", name="uq_messaging_installs_id_tenant"),
        ForeignKeyConstraint(
            ["tenant_id", "bridge_id"],
            ["collaboration_bridges.tenant_id", "collaboration_bridges.id"],
            name="fk_messaging_installs_bridge",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    platform: Mapped[str] = mapped_column(Text, nullable=False)
    external_workspace_id: Mapped[str] = mapped_column(Text, nullable=False)
    encrypted_bot_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    scopes: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    installed_by_user_id: Mapped[str] = mapped_column(
        Text, ForeignKey("users.id"), nullable=False
    )
    bridge_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    installed_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class MessagingInstallState(TenantScoped, Base):
    """One in-flight install: minted when the flow starts, burnt when it lands.

    An install is two requests with a trip through the platform in between. The
    first is an authenticated operator asking to install; the second is a
    browser arriving back at a public endpoint from the platform, carrying an
    authorization code and a `state` we chose. Nothing else ties the two
    together, so `state` has to carry the whole of what the second request may
    not be trusted to assert: which tenant, and on whose behalf.

    **The row is not what carries the tenant across.** The `state` parameter is
    a signed token naming the tenant, so the callback binds a tenant it can
    verify without reading anything first. That is the point of the design:
    every other unauthenticated entry point resolves its tenant through a
    `SECURITY DEFINER` lookup, and this one does not have to, so it does not —
    the closed list in `db/tenant_lookup.py` stays as short as it is. What this
    row adds is the one property a signature cannot have: **single use.** A
    signed token is valid until it expires and a captured one can be replayed;
    the redemption below happens once because `consumed_at` is set in the same
    statement that checks it is null.

    Which makes the failure this prevents worth naming. Replaying a captured
    state completes an install of the attacker's own workspace against the
    victim's tenant — that workspace's messages then arrive in the victim's
    rooms, which is message injection, not a leak. Single use and a short
    expiry are what close it.

    Redemption is a scoped write like any other, run after the signature has
    bound the tenant, so row-level security is a second check on the first: a
    token whose signed tenant disagrees with the row's finds no row at all.

    The two timestamps are both needed and mean different things. `expires_at`
    is a bound on how long the platform's round trip may take; `consumed_at`
    is the fact of redemption, kept rather than deleted so an operator asking
    why a link stopped working can see it was used rather than lost.
    """

    __tablename__ = "messaging_install_states"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    platform: Mapped[str] = mapped_column(Text, nullable=False)
    created_by_user_id: Mapped[str] = mapped_column(
        Text, ForeignKey("users.id"), nullable=False
    )
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[str | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class MessagingEventReceipt(TenantScoped, Base):
    """One inbound platform event, claimed once so it is handled once.

    Platforms deliver at least once. Slack gives three seconds to acknowledge
    an event and retries what it does not get an answer to — so a deployment
    under load, or one restarted mid-request, is told the same thing again.
    Without a record of what has been taken, the second telling produces a
    second answer in the customer's channel, which is the visible failure: an
    agent replying twice to one question.

    **The row is written before the work, not after**, and the unique index is
    what arbitrates. Two retries in flight at once both reach the insert and
    exactly one survives it; the loser stops there. Recording afterwards would
    order the two the wrong way round — both would dispatch, and the duplicate
    would be detected once it no longer mattered.

    That ordering chooses at-most-once over at-least-once, which is worth
    stating plainly: an event claimed by a process that then dies is not
    retried, because the platform has already been told 200 and this table says
    the event is taken. It is not a new loss. The route has acknowledged before
    handling since it was written — it has to, the deadline is shorter than a
    turn — so the event was already unrecoverable at that point. What this adds
    is `handled_at`, which makes the loss visible: a claimed row that never
    completed is a real event that reached nobody, and it can be found.

    `external_event_id` is the platform's own id for the delivery, and only
    some envelopes have one. Slack numbers Events API envelopes and retries
    only those; a slash command and an interaction get one shot and no id, so
    there is nothing to deduplicate and no row here. A missing id means "the
    platform does not retry this", not "this was not checked".

    Uniqueness is `(tenant_id, platform, external_event_id)` and not the
    deployment-wide pair, unlike the workspace claim on `messaging_installs`.
    The two would be equivalent — an event id is unique in the platform's own
    namespace and a workspace belongs to one tenant — so the tenant-local index
    is the one to prefer: it keeps one customer's event ids out of another's
    namespace entirely, and it means a conflict is always with a row the
    inserting tenant can actually see rather than an opaque refusal naming
    somebody else's.
    """

    __tablename__ = "messaging_event_receipts"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "platform",
            "external_event_id",
            name="uq_messaging_event_receipts_event",
        ),
        # Pruning reads this and nothing else. Receipts are only useful for as
        # long as the platform might still retry, and the table would otherwise
        # grow with every message the busiest workspace ever sends.
        Index("ix_messaging_event_receipts_received_at", "received_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    platform: Mapped[str] = mapped_column(Text, nullable=False)
    external_event_id: Mapped[str] = mapped_column(Text, nullable=False)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    handled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
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

    Liveness belongs to the holder, not the agent (room-agnostic, so hopping
    rooms keeps the seat). A holder that owns its inbound connection renews the
    lease on a fast cadence and is live by `last_seen_at`; an SDK session
    supervised by something else renews nothing, and is live for as long as
    `session_id` names a session whose host lease is current. An agent's
    permanent controller connection is neither, and so keeps no role alive.

    One lease per agent is enforced by the unique index on `agent_id`;
    `release_role` (or holder death + TTL) frees it, and release stays open to
    any of the agent's sessions. `transport_session_id` records the connection
    or MCP transport that assumed the role, and identifies the holder when
    there is no `session_id`.
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
    session_id: Mapped[str | None] = mapped_column(Text, nullable=True)
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


# ── Telemetry bookkeeping ────────────────────────────────────────────────────


class DeploymentIdentity(Base):
    """Who this installation is to the telemetry relay, and when it began.

    Not tenant-scoped: a deployment running several tenants is one subject.
    Exactly one row, pinned by a check constraint — two would silently double
    every count derived from it.

    `client_id` is a random UUID, derived from nothing, kept across restarts.

    `installed_at` is null where the identity was created against a database
    that already held content; milestones are suppressed for such a deployment
    rather than measured from a guess. The daily counts are unaffected.
    """

    __tablename__ = "deployment_identity"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_deployment_identity_singleton"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    client_id: Mapped[str] = mapped_column(Text, nullable=False, default=_uuid)
    installed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class TelemetryMilestone(Base):
    """A once-ever telemetry event that has already been reported.

    A row rather than process state, so a restart cannot re-emit one. The name
    is the primary key, which makes the insert itself the guard.
    """

    __tablename__ = "telemetry_milestones"

    name: Mapped[str] = mapped_column(Text, primary_key=True)
    emitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class TelemetrySnapshotWatermark(Base):
    """When the daily usage snapshot was last sent.

    Anchored to what was sent rather than to uptime, so restarts do not change
    the cadence. One row, pinned like the identity above.
    """

    __tablename__ = "telemetry_snapshot_watermark"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_telemetry_snapshot_watermark_singleton"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    last_sent_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
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
        # The usage snapshot's shape: one tenant's messages since a moment,
        # across every room. The index above leads on the room, so it cannot
        # serve that and each pass would scan the whole table.
        Index("ix_messages_tenant_sent_at", "tenant_id", "sent_at"),
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
    __table_args__ = (
        UniqueConstraint("tenant_id", "uri", name="uq_media_blobs_tenant_uri"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    uri: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    filename: Mapped[str | None] = mapped_column(Text, nullable=True)
    sha256: Mapped[str | None] = mapped_column(Text, nullable=True)
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


# ── Session activity ──────────────────────────────────────────────────────────
#
# What an agent's session reports about itself so messaging platforms can show
# it. The session and its transcript belong to the agent's host (Switch Console
# or a remote sidecar); these tables hold only what a platform renders and what
# the server must check when a person answers. Every write is one small row.

APPROVAL_REQUEST_STATES = ("open", "answered", "expired", "closed")
APPROVAL_REQUEST_KINDS = ("approval", "questions")
SESSION_ACTIVITY_KINDS = (
    "turn",
    "user-message",
    "assistant-message",
    "tool-activity",
    "notice",
)
TURN_STATUS_MARKS = ("queued", "working")


class ApprovalRequest(TenantScoped, Base):
    """A request a session is waiting on a person for, and the answer it gets.

    Either an approval (pick one of `options`) or a set of `questions`, each
    answered with options, words, or both. The host opens it; a person answers
    it from any platform; the server checks the answer against this row (still
    open, fits what was asked, not expired) and owes it to the agent until
    `delivered_at` is set. `request_id` is the host's, unique within its
    session, so a host that retries an open reaches the same row.
    """

    __tablename__ = "approval_requests"
    __table_args__ = (
        PrimaryKeyConstraint("tenant_id", "agent_id", "session_id", "request_id"),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_approval_requests_agent",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_approval_requests_room",
            ondelete="CASCADE",
        ),
        CheckConstraint(
            "state IN ('open', 'answered', 'expired', 'closed')",
            name="ck_approval_requests_state",
        ),
        CheckConstraint(
            "kind IN ('approval', 'questions')",
            name="ck_approval_requests_kind",
        ),
        Index(
            "ix_approval_requests_open_expiry",
            "expires_at",
            postgresql_where=text("state = 'open' AND expires_at IS NOT NULL"),
        ),
        Index(
            "ix_approval_requests_undelivered",
            "tenant_id",
            "agent_id",
            postgresql_where=text(
                "state IN ('answered', 'expired') AND delivered_at IS NULL"
            ),
        ),
    )

    agent_id: Mapped[str] = mapped_column(Text, nullable=False)
    session_id: Mapped[str] = mapped_column(Text, nullable=False)
    request_id: Mapped[str] = mapped_column(Text, nullable=False)
    turn_id: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    room_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    thread_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Approval: [{"id", "label", "decision"}, ...] in the order offered.
    options: Mapped[list] = mapped_column(JSONB, nullable=False)
    # Questions: [{"id", "title", "prompt", "options": [{"id", "label",
    # "description"}], "multi_select", "allow_custom_answer"}, ...].
    questions: Mapped[list] = mapped_column(JSONB, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False, default="open")
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Approval: the chosen option's id.
    answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Questions: [{"question_id", "selected_option_ids", "custom_text"}, ...].
    answers: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    answered_by: Mapped[str | None] = mapped_column(Text, nullable=True)
    answered_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    delivered_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class SessionActivityItem(TenantScoped, Base):
    """One step of a turn as a platform draws it: the turn itself, a message,
    a tool call, or a notice.

    Upserted by `revision`, so a step is one row however often it changes and
    a replayed report cannot move it backwards. The primary key leads with the
    turn, so reading every step of one turn is an index range.
    """

    __tablename__ = "session_activity_items"
    __table_args__ = (
        PrimaryKeyConstraint(
            "tenant_id", "agent_id", "session_id", "turn_id", "item_id"
        ),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_session_activity_items_agent",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_session_activity_items_room",
            ondelete="CASCADE",
        ),
        CheckConstraint(
            "kind IN ('turn', 'user-message', 'assistant-message', "
            "'tool-activity', 'notice')",
            name="ck_session_activity_items_kind",
        ),
        Index("ix_session_activity_items_updated_at", "updated_at"),
    )

    agent_id: Mapped[str] = mapped_column(Text, nullable=False)
    session_id: Mapped[str] = mapped_column(Text, nullable=False)
    turn_id: Mapped[str] = mapped_column(Text, nullable=False)
    item_id: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    revision: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    command_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    room_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The Switch message the turn answers, so a platform threads it there.
    thread_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The Switch message that asked, where a platform puts its work marker.
    message_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ApprovalRequestPost(TenantScoped, Base):
    """Where one approval request is shown on one bridge, and how it is named.

    `token` rides in the card's controls and `handle` (`A12`) is what a person
    types to answer in words; both resolve back to the request through this
    row, so neither names the session. `external_post_id` is null until the
    platform confirms the post. `removed_at` is set once an answered card has
    been taken off a platform that removes them, and `unconfirmed_notice_at`
    once the channel has been told a card's delivery could not be confirmed.
    """

    __tablename__ = "approval_request_posts"
    __table_args__ = (
        PrimaryKeyConstraint(
            "tenant_id", "bridge_id", "agent_id", "session_id", "request_id"
        ),
        ForeignKeyConstraint(
            ["tenant_id", "bridge_id"],
            ["collaboration_bridges.tenant_id", "collaboration_bridges.id"],
            name="fk_approval_request_posts_bridge",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_approval_request_posts_agent",
            ondelete="CASCADE",
        ),
        UniqueConstraint("token", name="uq_approval_request_posts_token"),
        Index(
            "uq_approval_request_posts_handle",
            "bridge_id",
            "external_channel_id",
            text("lower(handle)"),
            unique=True,
        ),
    )

    bridge_id: Mapped[str] = mapped_column(Text, nullable=False)
    agent_id: Mapped[str] = mapped_column(Text, nullable=False)
    session_id: Mapped[str] = mapped_column(Text, nullable=False)
    request_id: Mapped[str] = mapped_column(Text, nullable=False)
    token: Mapped[str] = mapped_column(Text, nullable=False)
    handle: Mapped[str] = mapped_column(Text, nullable=False)
    external_channel_id: Mapped[str] = mapped_column(Text, nullable=False)
    external_post_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The platform's thread root the card was posted under, if any.
    thread_ref: Mapped[str | None] = mapped_column(Text, nullable=True)
    removed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    unconfirmed_notice_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class TurnStatusPost(TenantScoped, Base):
    """The message a turn is drawn in on a bridge, and what hangs off it.

    `reaction_message_ref` is the asking message as posted on this platform,
    and `mark` the work marker this turn has put on it (`queued` / `working`),
    or null. `attention_post_id` is the separate message that says the turn is
    stuck, on a platform that uses one.
    """

    __tablename__ = "turn_status_posts"
    __table_args__ = (
        PrimaryKeyConstraint(
            "tenant_id", "bridge_id", "agent_id", "session_id", "turn_id"
        ),
        ForeignKeyConstraint(
            ["tenant_id", "bridge_id"],
            ["collaboration_bridges.tenant_id", "collaboration_bridges.id"],
            name="fk_turn_status_posts_bridge",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_turn_status_posts_agent",
            ondelete="CASCADE",
        ),
        CheckConstraint(
            "mark IN ('queued', 'working')",
            name="ck_turn_status_posts_mark",
        ),
    )

    bridge_id: Mapped[str] = mapped_column(Text, nullable=False)
    agent_id: Mapped[str] = mapped_column(Text, nullable=False)
    session_id: Mapped[str] = mapped_column(Text, nullable=False)
    turn_id: Mapped[str] = mapped_column(Text, nullable=False)
    external_channel_id: Mapped[str] = mapped_column(Text, nullable=False)
    external_post_id: Mapped[str] = mapped_column(Text, nullable=False)
    thread_ref: Mapped[str | None] = mapped_column(Text, nullable=True)
    reaction_message_ref: Mapped[str | None] = mapped_column(Text, nullable=True)
    mark: Mapped[str | None] = mapped_column(Text, nullable=True)
    attention_post_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


# As for messages: `create_all` has to build the announcing triggers too, or the
# push tests would exercise tables that announce nothing. The function is
# `CREATE OR REPLACE`, so creating it with each table is harmless.
for _table, _triggers in (
    (
        ApprovalRequest.__table__,
        (CREATE_APPROVAL_INSERT_TRIGGER, CREATE_APPROVAL_STATE_TRIGGER),
    ),
    (SessionActivityItem.__table__, (CREATE_ACTIVITY_TRIGGER,)),
):
    for _ddl in (CREATE_SESSION_ACTIVITY_NOTIFY_FUNCTION, *_triggers):
        event.listen(_table, "after_create", DDL(_ddl).execute_if(dialect="postgresql"))


# ── Usage metering ───────────────────────────────────────────────────────────


class UsageMetric(StrEnum):
    """What is counted. Cache reads and writes are kept apart from input
    tokens because providers price them apart."""

    MESSAGES = "messages"
    TURNS = "turns"
    INPUT_TOKENS = "input_tokens"
    OUTPUT_TOKENS = "output_tokens"
    CACHE_READ_TOKENS = "cache_read_tokens"
    CACHE_WRITE_TOKENS = "cache_write_tokens"


class TenantUsage(TenantScoped, Base):
    """What a tenant has consumed, counted as it happens, one row per hour.

    The record that quotas are enforced against and that billing will read,
    so it is kept apart from the rows it counts: deleting a room cascades to
    its messages, and a count derived from `messages` would forget usage the
    tenant has already spent. Written in the same transaction as the thing it
    counts, so the two cannot disagree.

    Hourly buckets because a budget period is configurable: any period of a
    whole number of hours is a sum over these rows, while a coarser bucket
    would fix the shortest period a budget can have.

    `client_id` is who consumed it: the sender of a message, or the client of
    the agent a turn ran for. No foreign key, so a count outlives the client it
    names. `model` is empty where a metric has none.
    """

    __tablename__ = "tenant_usage"
    __table_args__ = (
        # Leads on the metric so "this tenant's turns since a moment" — the
        # shape every budget check asks — is a range scan on the key itself.
        PrimaryKeyConstraint(
            "tenant_id", "metric", "bucket_start", "client_id", "model"
        ),
        CheckConstraint(
            "metric IN ({})".format(", ".join(f"'{m}'" for m in UsageMetric)),
            name="ck_tenant_usage_metric",
        ),
        CheckConstraint("amount > 0", name="ck_tenant_usage_amount"),
    )

    metric: Mapped[str] = mapped_column(Text, nullable=False)
    bucket_start: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    client_id: Mapped[str] = mapped_column(Text, nullable=False)
    model: Mapped[str] = mapped_column(Text, nullable=False)
    amount: Mapped[int] = mapped_column(BigInteger, nullable=False)


# A budget's period is at most a leap year, and its limit at most the largest
# integer a JavaScript client reads exactly. Both keep the period arithmetic
# and the gateway's numbers from overflowing.
MAX_BUDGET_PERIOD_HOURS = 8784
MAX_BUDGET_AMOUNT = 2**53 - 1


class UsageBudget(TenantScoped, Base):
    """A ceiling on one metric over a repeating period.

    `agent_id` null covers every agent in the tenant; otherwise the one agent.
    `model` empty covers every model. An agent that has reached any budget
    covering it is stopped until the period turns over; people are never
    stopped. A tenant with no budgets is unlimited.

    Periods are whole hours counted from the Unix epoch in UTC, so a daily
    budget turns over at midnight UTC and every writer agrees when.
    """

    __tablename__ = "usage_budgets"
    __table_args__ = (
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_usage_budgets_agent",
            ondelete="CASCADE",
        ),
        CheckConstraint(
            "metric IN ({})".format(", ".join(f"'{m}'" for m in UsageMetric)),
            name="ck_usage_budgets_metric",
        ),
        CheckConstraint(
            f"amount_limit > 0 AND amount_limit <= {MAX_BUDGET_AMOUNT}",
            name="ck_usage_budgets_amount_limit",
        ),
        CheckConstraint(
            f"period_hours > 0 AND period_hours <= {MAX_BUDGET_PERIOD_HOURS}",
            name="ck_usage_budgets_period_hours",
        ),
        Index(
            "uq_usage_budgets_tenant_wide",
            "tenant_id",
            "metric",
            "model",
            unique=True,
            postgresql_where=text("agent_id IS NULL"),
        ),
        Index(
            "uq_usage_budgets_agent",
            "tenant_id",
            "agent_id",
            "metric",
            "model",
            unique=True,
            postgresql_where=text("agent_id IS NOT NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    agent_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    metric: Mapped[str] = mapped_column(Text, nullable=False)
    model: Mapped[str] = mapped_column(Text, nullable=False)
    amount_limit: Mapped[int] = mapped_column(BigInteger, nullable=False)
    period_hours: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
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
