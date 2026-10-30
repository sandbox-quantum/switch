import uuid
from datetime import datetime
from enum import StrEnum
from typing import Any

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
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, declared_attr, mapped_column

from switch_core.db.agent_event_notify_ddl import (
    CREATE_AGENT_EVENT_NOTIFY_FUNCTION,
    CREATE_AGENT_EVENT_NOTIFY_TRIGGER,
    DROP_AGENT_EVENT_NOTIFY_TRIGGER,
)
from switch_core.db.base import Base
from switch_core.db.encrypted_json import EncryptedJSONB
from switch_core.db.membership_notify_ddl import (
    CREATE_MEMBERSHIP_NOTIFY_FUNCTION,
    CREATE_MEMBERSHIP_NOTIFY_TRIGGER,
    DROP_MEMBERSHIP_NOTIFY_TRIGGER,
)
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

#: The highest boot number `agent_event_boot` hands out. An agent's own event
#: numbers start at the boot number shifted left 32 bits, so they stay below
#: `(AGENT_EVENT_BOOT_MAX + 1) << 32`, the first ticket id (`TICKET_FLOOR`).
AGENT_EVENT_BOOT_MAX = 2097150

#: The first id of `agent_position_tickets`. Every own event number is below it
#: (see `AGENT_EVENT_BOOT_MAX`), and every ticket id from here to
#: `TICKET_CEILING` is an integer a JavaScript client holds exactly.
TICKET_FLOOR = (AGENT_EVENT_BOOT_MAX + 1) << 32
TICKET_CEILING = 2**53 - 1

agent_event_boot_sequence = Sequence(
    "agent_event_boot",
    metadata=Base.metadata,
    maxvalue=AGENT_EVENT_BOOT_MAX,
    cycle=False,
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
    # Whether a catalog service no workspace admin has switched on or off
    # (`WorkspaceServiceSetting`) is on. Off for every workspace made since
    # services started off; on for those that already had members then, so
    # what they were using kept working.
    services_on_by_default: Mapped[bool] = mapped_column(
        Boolean, server_default="false", nullable=False
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
        Index("ix_api_keys_tenant_id", "tenant_id"),
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
            "provider = 'github'",
            name="ck_provider_connections_provider",
        ),
        CheckConstraint(
            "kind = 'oauth'",
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


class CloudMachine(Base):
    """One user's Switch cloud VM, whichever workspaces it serves.

    Global, as the person who owns it is: one VM and one disk per user, with
    one lifecycle. What it runs in each workspace is that workspace's
    `MachineWorkspace` row, which is scoped. Nothing here names a workspace.
    """

    __tablename__ = "cloud_machines"
    __table_args__ = (
        CheckConstraint(
            "state IN ('queued', 'provisioning', 'ready', 'stopping', 'stopped', 'error', 'retained', 'deleting', 'deleted')",
            name="ck_cloud_machine_state",
        ),
        CheckConstraint(
            "desired_state IN ('running', 'stopped', 'retained', 'deleted')",
            name="ck_cloud_machine_desired_state",
        ),
        CheckConstraint(
            "stop_reason IS NULL OR stop_reason IN ('idle', 'owner')",
            name="ck_cloud_machine_stop_reason",
        ),
        Index(
            "uq_cloud_machine_owner",
            "owner_id",
            unique=True,
            postgresql_where=text("state <> 'deleted'"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    owner_id: Mapped[str] = mapped_column(Text, ForeignKey("users.id"), nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    desired_state: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="running"
    )
    stop_reason: Mapped[str | None] = mapped_column(Text)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    instance_type: Mapped[str | None] = mapped_column(Text)
    data_volume_id: Mapped[str | None] = mapped_column(Text)
    instance_id: Mapped[str | None] = mapped_column(Text)
    retain_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    active_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # The machine's disk and memory, and per workspace (keyed by its
    # `MachineWorkspace` id) when its controller last reported and how many
    # sessions it ran: `{disk, memory, controllers: {id: {at, sessions_running}}}`.
    heartbeat: Mapped[dict | None] = mapped_column(JSONB)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    #: When Core first saw the machine reported `running` for this revision.
    running_observed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    error: Mapped[str | None] = mapped_column(Text)
    error_code: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class MachineWorkspace(TenantScoped, Base):
    """A workspace on its owner's cloud machine: the agent controller the
    machine runs for this workspace, enrolled with a one-time code minted here.
    The owner's managed agents placed on that controller run on the machine."""

    __tablename__ = "machine_workspaces"
    __table_args__ = (
        PrimaryKeyConstraint("tenant_id", "id"),
        ForeignKeyConstraint(
            ["tenant_id", "controller_id"],
            ["agent_controllers.tenant_id", "agent_controllers.id"],
            name="fk_machine_workspaces_controller",
            ondelete="SET NULL (controller_id)",
        ),
        UniqueConstraint(
            "tenant_id", "machine_id", name="uq_machine_workspaces_machine"
        ),
        Index("ix_machine_workspaces_machine_id", "machine_id"),
    )

    id: Mapped[str] = mapped_column(Text, nullable=False)
    machine_id: Mapped[str] = mapped_column(
        Text, ForeignKey("cloud_machines.id"), nullable=False
    )
    owner_id: Mapped[str] = mapped_column(Text, ForeignKey("users.id"), nullable=False)
    controller_id: Mapped[str | None] = mapped_column(Text)
    # The code the controller enrolls with, kept for the machine revision it
    # was issued at, so every retry of that revision hands over the same one.
    enrollment_code_encrypted: Mapped[str | None] = mapped_column(Text)
    enrollment_code_revision: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
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
        Index("ix_invitations_tenant_id", "tenant_id"),
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


class TenantJoinDomain(TenantScoped, Base):
    """An e-mail domain whose people may join a tenant without an invitation.

    Anyone signed in with an address at `domain` is offered the tenant and
    joins it as a member. The natural key is `(tenant_id, domain)`, so
    `tenant_id` joins the primary key directly, as on `reference_types`, and
    two tenants may each open themselves to the same domain.

    `domain` is stored lower-case, and the constraint is what makes that true
    rather than a convention: the lookup that finds these rows
    (`tenants_open_to_domain`, `db/tenant_lookup.py`) compares by equality,
    and a mixed-case row would be one nobody could ever match.

    Who may add a domain, and which, is the gateway's decision rather than this
    row's — today an admin may open a tenant only to the domain of their own
    address, and never to a public e-mail provider's.
    """

    __tablename__ = "tenant_join_domains"
    __table_args__ = (
        CheckConstraint(
            "domain = lower(domain)", name="ck_tenant_join_domains_lower_case"
        ),
    )

    tenant_id: Mapped[str] = mapped_column(
        Text,
        ForeignKey("tenants.id", name="fk_tenant_join_domains_tenant"),
        primary_key=True,
        default=require_tenant_id,
    )
    domain: Mapped[str] = mapped_column(Text, primary_key=True)
    created_by: Mapped[str] = mapped_column(
        Text, ForeignKey("users.id"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class AuditEvent(TenantScoped, Base):
    """One security-relevant change in a tenant: who did what, to what, when.

    Written in the same transaction as the change it records wherever that
    change is made on the caller's session, so a change that rolls back
    leaves no event. Where a service commits the change on sessions of its
    own (registering or removing a bridge, disconnecting an install), the
    event is written after it succeeds, so it never describes a change that
    did not happen.

    Append-only for the runtime role: `grant_runtime_role` takes `UPDATE` and
    `DELETE` on this table back off it, so the process serving requests can
    add to the history but not rewrite it.

    `actor_user_id` carries no foreign key, so the history outlives the
    account; it is null when no signed-in person acted. `details` holds
    identifiers and field names, never secrets or the values of connection
    settings.

    `occurred_at` defaults to `clock_timestamp()`, not `now()`: two events in
    one transaction would otherwise share a timestamp, and the read pages back
    by it.
    """

    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_events_tenant_occurred_at", "tenant_id", "occurred_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp(), nullable=False
    )
    actor_user_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    target_type: Mapped[str] = mapped_column(Text, nullable=False)
    target_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    details: Mapped[dict | None] = mapped_column(JSONB, nullable=True)


# ── Clients ────────────────────────────────────────────────────────────────────


class Client(TenantScoped, Base):
    __tablename__ = "clients"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "matrix_user_id", name="uq_clients_tenant_matrix_user_id"
        ),
        UniqueConstraint("id", "tenant_id", name="uq_clients_id_tenant"),
        UniqueConstraint("tenant_id", "user_id", name="uq_clients_tenant_user_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    # The column keeps its Matrix-era name; the attribute says what it is.
    transport_user_id: Mapped[str] = mapped_column(
        "matrix_user_id", Text, nullable=False
    )
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # The gateway user a `member` client speaks for: a person in a room as
    # themselves, through Switch Console, rather than through a platform
    # account. NULL for every other client type.
    user_id: Mapped[str | None] = mapped_column(
        Text,
        ForeignKey("users.id", ondelete="SET NULL", name="fk_clients_user"),
        nullable=True,
    )
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ClientRoom(TenantScoped, Base):
    __tablename__ = "client_rooms"
    __table_args__ = (
        Index("ix_client_rooms_tenant_id", "tenant_id"),
        # What a membership's delivery cursor refers to, tenant included, as
        # every reference between scoped tables does (`DeliveryCursor`).
        UniqueConstraint(
            "tenant_id",
            "client_id",
            "room_id",
            name="uq_client_rooms_tenant_client_room",
        ),
        # The router reads a room's members on every row it writes there.
        Index("ix_client_rooms_room_id", "room_id"),
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
        # Deployment-wide, not per tenant: an OIDC sign-in resolves the agent
        # from its client id before any tenant is known.
        Index(
            "uq_agents_oauth_client_id",
            "oauth_client_id",
            unique=True,
            postgresql_where=text("oauth_client_id IS NOT NULL"),
        ),
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
    # the display layer falls back to `name`. Never the client display
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
    # Whether the agent may act on its owner's agent management through the
    # agent operations: list the owner's machines and managed agents, and
    # create managed agents on those machines. Off unless the owner turns it
    # on, and never inherited by an agent it creates.
    can_manage_agents: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false", default=False
    )
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Tools ──────────────────────────────────────────────────────────────────────


class Tool(TenantScoped, Base):
    __tablename__ = "tools"
    __table_args__ = (
        Index("ix_tools_tenant_id", "tenant_id"),
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
        Index("ix_models_tenant_id", "tenant_id"),
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
    Index("ix_agent_skills_tenant_id", "tenant_id"),
)


class Skill(TenantScoped, Base):
    __tablename__ = "skills"
    __table_args__ = (
        Index("ix_skills_tenant_id", "tenant_id"),
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
        ondelete="CASCADE",
    ),
    ForeignKeyConstraint(
        ["tenant_id", "agent_id"],
        ["agents.tenant_id", "agents.id"],
        name="fk_room_agents_agent",
    ),
    Index("ix_room_agents_tenant_id", "tenant_id"),
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
        ondelete="CASCADE",
    ),
    ForeignKeyConstraint(
        ["tenant_id", "skill_id"],
        ["skills.tenant_id", "skills.id"],
        name="fk_room_skills_skill",
    ),
    Index("ix_room_skills_tenant_id", "tenant_id"),
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
        # A run is listed, checked and stopped by its root on every agent
        # create and every look at Recently used.
        Index("ix_rooms_run_id", "run_id"),
        # One room per Switch Console create request, whichever process or
        # retry gets there first.
        Index(
            "uq_rooms_chat_operation_id",
            "tenant_id",
            text("(metadata ->> 'chat_operation_id')"),
            unique=True,
            postgresql_where=text("metadata ? 'chat_operation_id'"),
        ),
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
        ForeignKeyConstraint(
            ["tenant_id", "created_by_agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_rooms_created_by_agent",
            ondelete="SET NULL (created_by_agent_id)",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "parent_room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_rooms_parent_room",
            ondelete="SET NULL (parent_room_id)",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    # The column keeps its Matrix-era name; the attribute says what it is.
    transport_room_id: Mapped[str] = mapped_column(
        "matrix_room_id", Text, nullable=False
    )
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
    # The agent that created the room through an agent operation. NULL for a
    # room a person created. `created_by` is the agent's owner in both cases.
    created_by_agent_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Where an agent-created room sits in its run (see `agent_runs`): the
    # room the agent was working in when it asked, and the root of the chain,
    # a room a person made. NULL for a person's room, which is its own root.
    parent_room_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    run_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The template the room came from, when it came from one: its registry
    # name, or the name the creator gave a pasted document.
    template_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    # A fingerprint of the kickoff an agent posted here. Never shown; it is
    # how the same request made twice on one path is recognised.
    kickoff_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    # On a run's root only: whether agents may keep creating rooms in the
    # run. NULL means running. See `agent_runs.RunControl`.
    run_control: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
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
    # members, room, and bridge channel are untouched. NULL = active.
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
        Index("ix_room_groups_tenant_id", "tenant_id"),
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
        Index("ix_room_links_tenant_id", "tenant_id"),
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
        Index("ix_tasks_tenant_id", "tenant_id"),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_tasks_room",
            ondelete="CASCADE",
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
        ondelete="CASCADE",
    ),
    ForeignKeyConstraint(
        ["tenant_id", "reference_id"],
        ["references.tenant_id", "references.id"],
        name="fk_room_references_reference",
    ),
    Index("ix_room_references_tenant_id", "tenant_id"),
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
        ondelete="CASCADE",
    ),
    ForeignKeyConstraint(
        ["tenant_id", "document_id"],
        ["documents.tenant_id", "documents.id"],
        name="fk_room_documents_document",
    ),
    Index("ix_room_documents_tenant_id", "tenant_id"),
)


class Reference(TenantScoped, Base):
    __tablename__ = "references"
    __table_args__ = (
        Index("ix_references_tenant_id", "tenant_id"),
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
        Index("ix_documents_tenant_id", "tenant_id"),
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
        Index("ix_templates_tenant_id", "tenant_id"),
        # Not widened to include the tenant: an owner belongs to one, so
        # scoping the name to the owner already scopes it to the tenant.
        UniqueConstraint("owner_id", "name", name="uq_templates_owner_name"),
        UniqueConstraint("id", "tenant_id", name="uq_templates_id_tenant"),
        ForeignKeyConstraint(
            ["tenant_id", "created_by_agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_templates_created_by_agent",
            ondelete="SET NULL (created_by_agent_id)",
        ),
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
    # The agent that saved it through an agent operation, NULL for a person.
    # ``owner_id`` is the agent's owner either way; only this agent may change
    # or delete what it saved (see ``agent_template_ops``).
    created_by_agent_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[str] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class TemplateInstall(TenantScoped, Base):
    """One run of a template whose source the server vouches for: which
    template, at which revision, and what it was run with.

    ``source`` is ``official`` for a template that comes with Switch
    (``template_id`` is its ``official:`` id, which nobody can save under) or
    ``saved`` for a stored template (``template_id`` is its row's id, kept
    after the row is deleted). ``inputs`` and ``builtins`` are what the
    document was rendered with, so a later revision can be rendered the same
    way to see what it would set. Written only by the server, when it runs a
    template; nothing a caller sends names one.
    """

    __tablename__ = "template_installs"
    __table_args__ = (
        UniqueConstraint("id", "tenant_id", name="uq_template_installs_id_tenant"),
        CheckConstraint(
            "source IN ('official', 'saved')", name="ck_template_installs_source"
        ),
        Index("ix_template_installs_tenant_template", "tenant_id", "template_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    # Goes with its owner, whose agents it created go too.
    owner_id: Mapped[str] = mapped_column(
        Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    source: Mapped[str] = mapped_column(Text, nullable=False)
    template_id: Mapped[str] = mapped_column(Text, nullable=False)
    template_name: Mapped[str] = mapped_column(Text, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    inputs: Mapped[dict] = mapped_column(JSONB, nullable=False)
    builtins: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class TemplateInstallResource(TenantScoped, Base):
    """An agent or room a template install created, under the key the
    template gives it, with a fingerprint of each value the template set.

    A fingerprint still equal to the value's own is a value nobody has
    changed since the template set it, which an update may replace; one that
    differs was changed by someone, and is left as they made it. Exactly one
    of ``agent_id`` and ``room_id`` is set, and the row goes with it.
    """

    __tablename__ = "template_install_resources"
    __table_args__ = (
        ForeignKeyConstraint(
            ["tenant_id", "install_id"],
            ["template_installs.tenant_id", "template_installs.id"],
            name="fk_template_install_resources_install",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_template_install_resources_agent",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_template_install_resources_room",
            ondelete="CASCADE",
        ),
        CheckConstraint(
            "(agent_id IS NULL) <> (room_id IS NULL)",
            name="ck_template_install_resources_one_resource",
        ),
        Index(
            "uq_template_install_resources_agent",
            "tenant_id",
            "agent_id",
            unique=True,
            postgresql_where=text("agent_id IS NOT NULL"),
        ),
        Index(
            "uq_template_install_resources_room",
            "tenant_id",
            "room_id",
            unique=True,
            postgresql_where=text("room_id IS NOT NULL"),
        ),
        Index("ix_template_install_resources_install", "tenant_id", "install_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    install_id: Mapped[str] = mapped_column(Text, nullable=False)
    key: Mapped[str] = mapped_column(Text, nullable=False)
    agent_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    room_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    fingerprints: Mapped[dict] = mapped_column(JSONB, nullable=False)
    # What Switch has to tell the agent about its template, until it reads
    # how it differs from it (``get_template_status``): a newer revision it
    # was not brought fully up to. Null when there is nothing to tell.
    notice: Mapped[str | None] = mapped_column(Text, nullable=True)


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
        ondelete="CASCADE",
    ),
    ForeignKeyConstraint(
        ["tenant_id", "package_id"],
        ["packages.tenant_id", "packages.id"],
        name="fk_room_packages_package",
    ),
    Index("ix_room_packages_tenant_id", "tenant_id"),
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
    Index("ix_package_references_tenant_id", "tenant_id"),
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
    Index("ix_package_documents_tenant_id", "tenant_id"),
)


class Package(TenantScoped, Base):
    __tablename__ = "packages"
    __table_args__ = (
        Index("ix_packages_tenant_id", "tenant_id"),
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
        Index("ix_collaboration_bridges_tenant_id", "tenant_id"),
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
    connection_config: Mapped[dict | None] = mapped_column(
        EncryptedJSONB, nullable=True
    )
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
    # Registered by the deployment's own setup step — the bundled Mattermost —
    # rather than by a person. Telemetry reads it so that "time to first
    # connector" measures a person connecting their platform, not a
    # deployment booting.
    preconfigured: Mapped[bool] = mapped_column(
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
    schema stores (`Keyring.encrypt`, the at-rest key), so it
    is protected against a stolen dump and not against a compromised process.
    A per-tenant key is a stronger boundary and a later decision. It is
    nullable so that an install which has ended can keep its record without
    keeping its secret: the token is worthless by then, and a worthless
    credential still reads like a credential to whoever finds the dump.

    `scopes` is the platform's own spelling of what was granted, stored
    verbatim rather than parsed into a list — a scope string that means
    nothing to us is still the thing to show an operator asking why a call was
    refused.

    `platform_data` is what one platform needs to remember about an install
    and no other platform has: Teams' id for the app in the customer's own
    catalogue, say, which differs per organisation and is needed to act on it
    later. Never a secret — those have a column, and an encryption — and never
    in the bridge's connection config, which a workspace admin can edit. Empty
    for a platform that has nothing to keep.
    """

    __tablename__ = "messaging_installs"
    __table_args__ = (
        Index("ix_messaging_installs_tenant_id", "tenant_id"),
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
    platform_data: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
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

    `decided_at` is the second single use. Redeeming the state does not claim
    the workspace: the callback asks whoever approved it to confirm which
    organisation it joins, and their Connect or Cancel is recorded here, once.
    """

    __tablename__ = "messaging_install_states"
    __table_args__ = (Index("ix_messaging_install_states_tenant_id", "tenant_id"),)

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
    decided_at: Mapped[str | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # The chat a claim-based install (Telegram) was put to when its state was
    # redeemed; only an answer from that chat may decide it. In the row, not
    # in the memory of the process that posted the proposal, because the
    # admin's answer may reach any switch-core process.
    proposed_chat_id: Mapped[str | None] = mapped_column(Text, nullable=True)


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


# Nothing reads or writes this table any more. It is dropped a release after
# the code that used it went, so a release still running that code during a
# rolling deploy finds it there (`migrations/script.py.mako`). Until then the
# model keeps `create_all` in step with the migrated schema.
class ServerConnector(TenantScoped, Base):
    __tablename__ = "server_connectors"
    __table_args__ = (
        Index("ix_server_connectors_tenant_id", "tenant_id"),
        ForeignKeyConstraint(
            ["tenant_id", "api_key_id"],
            ["api_keys.tenant_id", "api_keys.id"],
            name="fk_server_connectors_api_key",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    connection_config: Mapped[dict | None] = mapped_column(
        EncryptedJSONB, nullable=True
    )
    api_key_id: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── External Users ─────────────────────────────────────────────────────────────


class ExternalUser(TenantScoped, Base):
    __tablename__ = "external_users"
    __table_args__ = (
        Index("ix_external_users_tenant_id", "tenant_id"),
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
        Index("ix_external_user_claims_tenant_id", "tenant_id"),
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
        Index("ix_agent_sessions_tenant_id", "tenant_id"),
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
        Index("ix_agent_runtime_states_tenant_id", "tenant_id"),
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
        Index("ix_room_roles_tenant_id", "tenant_id"),
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
        Index("ix_role_leases_tenant_id", "tenant_id"),
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
    the other. A room message going out is claimed here before it is posted.
    """

    __tablename__ = "bridge_message_map"
    __table_args__ = (
        Index("ix_bridge_message_map_tenant_id", "tenant_id"),
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
    # Null while a room message is claimed for posting and not posted yet: an
    # outbound relay writes the row first and fills this in after the platform
    # answers, so a second process handling the same message finds the claim
    # and does not post it again (`CollaborationCore._claim_outbound`).
    external_post_id: Mapped[str | None] = mapped_column(Text, nullable=True)
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


# ── Switch-core processes ────────────────────────────────────────────────────


class SwitchCoreProcess(Base):
    """A running switch-core process's lease (`process_lease.py`).

    Every process claims a row at startup under its process id
    (`process_identity.py`), renews `beat_at` every few seconds, and sets
    `stopped_at` as it shuts down. An agent or controller connection whose
    holding process's lease is stale, stopped or gone reads as offline, which
    is how a process that died without writing its connections' closings is
    noticed, and work it owned (`OwnershipLease`) may be taken over. One
    write per process per renewal, however much it holds.

    Not tenant-scoped: a process serves every tenant. Rows long stale are
    pruned by the live processes.
    """

    __tablename__ = "switch_core_processes"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    beat_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    stopped_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # The ids of the `SECRET_KEYS` this process can read, so a process
    # starting with a new front key can tell whether every live one could read
    # what it writes (`db/key_rotation.py`). Ids only, never key material.
    # NULL for a process from before the column.
    key_ids: Mapped[list[str] | None] = mapped_column(ARRAY(Text), nullable=True)


# ── Schema revisions ─────────────────────────────────────────────────────────


class SchemaExpandOnlyRevision(Base):
    """An applied schema revision that only added to the schema.

    Written by `migrations/env.py` as Alembic applies a revision marked
    `expand_only`, and deleted as it is undone, with the revision it follows.
    A switch-core release older than the schema reads this chain back from the
    database's head to its own (`db/schema_version.py`): if every revision in
    between is here, it can serve on the newer schema, which is what lets two
    releases run side by side during a rolling deploy. The older release has
    no copy of those revisions' files, so the database is the only place it
    can learn this.
    """

    __tablename__ = "schema_expand_only_revisions"

    revision: Mapped[str] = mapped_column(Text, primary_key=True)
    down_revision: Mapped[str] = mapped_column(Text, nullable=False)
    applied_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class OwnershipLease(Base):
    """Which switch-core process runs a piece of work that must run once.

    One row per piece of work: `kind` says what it is (a client's consumer, a
    collaboration bridge's platform connection) and `key` which one (the
    client's or the bridge's id). `process_id` is the holder, null once it
    has let go. A holder counts only while its own lease in
    `switch_core_processes` holds, so a process that dies loses everything it
    held when that lease lapses, with no write of its own (`ownership.py`).

    `token` grows by one with every claim, and the holder's writes that must
    not outlive its hold name it (`DeliveryCursorStore.advance`), so a holder
    that was taken over without knowing it is refused rather than obeyed.

    Not tenant-scoped: one process holds work for every tenant at once, and a
    row names only which process runs which id.
    """

    __tablename__ = "ownership_leases"
    __table_args__ = (Index("ix_ownership_leases_process_id", "process_id"),)

    kind: Mapped[str] = mapped_column(Text, primary_key=True)
    key: Mapped[str] = mapped_column(Text, primary_key=True)
    process_id: Mapped[str | None] = mapped_column(
        Text,
        ForeignKey(
            "switch_core_processes.id",
            name="fk_ownership_leases_process",
            ondelete="SET NULL",
        ),
        nullable=True,
    )
    token: Mapped[int] = mapped_column(BigInteger, nullable=False)
    changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# ── Trust settings ───────────────────────────────────────────────────────────


class TrustSettings(Base):
    """Server-global Switch Trust guardrails configuration — one row.

    No row, or one with ``policy_id``/``api_key_encrypted`` unset, means the
    check is off (see ``switch_core.trust.client.DynamicTrustClient``). ``id``
    is a fixed constant (``db/stores/trust_settings_store.py``) rather than a
    generated key, since there is exactly one row by construction.
    """

    __tablename__ = "trust_settings"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    policy_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    api_key_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
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
    originates on a bridged platform, which enter through that user's human actor.

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
        # A sender's retry of the same part is the same row, never a second one.
        Index(
            "uq_messages_sender_client_txn",
            "sender_client_id",
            "client_txn_id",
            unique=True,
            postgresql_where=text("client_txn_id IS NOT NULL"),
        ),
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
    # The message's position in its room's log: the room's offset, in Kafka
    # terms (room = partition, seq = offset, a reader's cursor = its consumer
    # offset). It means something only within its room: unique per room, and
    # two rooms can each have a message 5.
    #
    # Live messages (MessageStore.create) count up from 1 with no gaps, in
    # commit order, and a number is never renumbered or reused. Reconstructed
    # history (MessageStore.create_historical) counts down from -1, below the
    # room's oldest, so seq can be negative and ordering by it still walks the
    # room in the order things happened.
    #
    # A reader's cursor is the last seq it has, and it reads `seq > cursor`.
    # Commit order is what makes that safe: nothing can later commit behind a
    # cursor. A Postgres sequence would not give it, because it hands out
    # numbers when a statement runs rather than when it commits. See
    # MessageStore._next_seq for the argument in full.
    #
    # Not the `sequence` an agent sees on its event stream: that one is the
    # event buffer's, numbered per agent across all its rooms.
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
    # The sender's own idempotency key for this part, `{requestId}:{index}`,
    # set by Switch Console sends. NULL for everything else.
    client_txn_id: Mapped[str | None] = mapped_column(Text, nullable=True)


class MessageAttachment(TenantScoped, Base):
    """A file carried by a message.

    One row per file, so a multi-file send is several rows against one message
    in the order they were sent.
    """

    __tablename__ = "message_attachments"
    __table_args__ = (
        Index("ix_message_attachments_tenant_id", "tenant_id"),
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
    """How far one client's consumer has handled one room it is a member of.

    A consumer reads its rooms from these rows, so whichever switch-core
    process owns the client (`ownership.py`) resumes where the last owner
    stopped, after a restart or a hand-over, instead of at the room's newest
    row. Every row the consumer reads moves its cursor, whether or not the
    row did anything; that is what lets an agent's reader treat a room row as
    decided once the cursor of the agent's consumer has passed it
    (`EventBuffer.read_conversation`).

    `last_seq` is a position in the room (`messages.seq`), only ever moved
    forward: a cursor that went back would hand its consumer rows it had
    already acted on. Only the owner moves it, checked against its lease
    token in the same statement (`DeliveryCursorStore.advance`).

    Keyed by the membership and deleted with it, so a client taken out of a
    room and added back starts from its new arrival, never from where it had
    got to before. `RoomStore.add_client` writes the first value, the room's
    newest row, in the transaction that writes the membership.
    """

    __tablename__ = "delivery_cursors"
    __table_args__ = (
        Index("ix_delivery_cursors_tenant_id", "tenant_id"),
        ForeignKeyConstraint(
            ["tenant_id", "client_id", "room_id"],
            [
                "client_rooms.tenant_id",
                "client_rooms.client_id",
                "client_rooms.room_id",
            ],
            name="fk_delivery_cursors_membership",
            ondelete="CASCADE",
        ),
    )

    client_id: Mapped[str] = mapped_column(Text, primary_key=True)
    room_id: Mapped[str] = mapped_column(Text, primary_key=True)
    last_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class AgentEventRow(TenantScoped, Base):
    """One of an agent's own events: an event meant for that agent, not one it
    sent.

    The router (`delivery/router.py`) writes a row, in the transaction that
    writes the room row, when that room row is for the agent: a message
    addressed to it or a join it is set to listen for. A room command's
    handler writes one for a command it passes on to the agent. Whether a row is for the agent depends on the room's state at the
    moment it is written, so the decision is recorded here instead of being
    worked out again at read time. The rest of a room's conversation is not
    copied here; a reader that wants it reads `messages`.

    `seq` numbers the own events of one agent. The numbers are contiguous
    and never reused (`AgentEventHead` hands them out). `payload` is the event
    exactly as it is sent to the agent. `notifiable` is false only for
    commands, and a connection that asked for addressed events only reads the
    rows where it is true.

    `room_seq` is the `messages.seq` of the room row the event came from. When
    several files are posted as one message, it is the row of the last part to
    arrive. `message_key` is the attachment group id for such a message and the
    row's own event id otherwise. A reader that combines these own events with
    the room's conversation uses the pair to leave out the rows of `messages`
    it has already received from here.

    `message_key`, `room_id`, `room_seq` and `type` together name the source of
    an event, and an agent has at most one event per source
    (`uq_agent_events_source`). The router stores nothing for a source already
    stored, and `EventBuffer.enqueue` hands back the number of the event
    already stored instead of storing a second copy. A file of a multi-file
    message that arrives after the message was delivered has a later
    `room_seq`, so it is stored as an event of its own.

    The retention loop in `main.py` deletes rows older than
    `agent_event_retention_seconds`. It never deletes from `messages`.
    """

    __tablename__ = "agent_events"
    __table_args__ = (
        Index("ix_agent_events_tenant_id", "tenant_id"),
        Index("ix_agent_events_created_at", "created_at"),
        Index(
            "ix_agent_events_agent_room_seq",
            "tenant_id",
            "agent_id",
            "room_id",
            "room_seq",
        ),
        # One decision is stored once. The same room row decided again (by an
        # agent consumer of an older release during a rolling deploy) or an
        # event written again after a commit whose acknowledgement was lost
        # finds this row already there.
        Index(
            "uq_agent_events_source",
            "agent_id",
            "message_key",
            "room_id",
            "room_seq",
            "type",
            unique=True,
            postgresql_where=text("message_key IS NOT NULL"),
        ),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_events_agent",
            ondelete="CASCADE",
        ),
    )

    agent_id: Mapped[str] = mapped_column(Text, primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    room_id: Mapped[str] = mapped_column(Text, nullable=False)
    room_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    message_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    notifiable: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class AgentEventHead(TenantScoped, Base):
    """The first and the latest `agent_events.seq` given out for one agent.

    `EventBuffer.enqueue` takes the next number from `last_seq` here rather
    than from the highest row in `agent_events`, because the retention loop
    deletes old rows. If the newest rows were deleted and their numbers handed
    out again, a client that had already read up to one of those numbers
    would treat the new event carrying it as one it had seen, and never
    receive it.

    `first_seq` is the number of the agent's first event. It is derived from
    the boot number (`agent_event_boot`, shifted left 32 bits) of the process
    that first read the agent's head or wrote its first event, whichever came
    first, which puts it above every number an earlier server process could
    have given a client. A client resuming from such a number is therefore
    below everything stored here and is told it has a gap. The row is written
    on that first read so that every process numbers the agent alike: before
    it exists, processes of different boots would each answer from their own
    boot number.
    """

    __tablename__ = "agent_event_heads"
    __table_args__ = (
        Index("ix_agent_event_heads_tenant_id", "tenant_id"),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_event_heads_agent",
            ondelete="CASCADE",
        ),
    )

    agent_id: Mapped[str] = mapped_column(Text, primary_key=True)
    first_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    last_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)


class AgentEventDrop(TenantScoped, Base):
    """The newest `agent_events.seq` that retention deleted, per agent and room.

    `EventBuffer.expire` writes `dropped_through` when it deletes an agent's
    rows. A client that resumes from a number below it has missed events in
    that room. The stream then opens with a gap that names the room, instead
    of carrying on as if nothing were missing.
    """

    __tablename__ = "agent_event_drops"
    __table_args__ = (
        Index("ix_agent_event_drops_tenant_id", "tenant_id"),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_event_drops_agent",
            ondelete="CASCADE",
        ),
    )

    agent_id: Mapped[str] = mapped_column(Text, primary_key=True)
    room_id: Mapped[str] = mapped_column(Text, primary_key=True)
    dropped_through: Mapped[int] = mapped_column(BigInteger, nullable=False)


class PendingAttachmentGroup(TenantScoped, Base):
    """A multi-file post whose files have not all been written yet.

    Several files posted as one message are written as one row each in
    `messages`, sharing a group id (`attachments.py`). Whether the post is for
    an agent, and the one own event it becomes, can only be decided once the
    files are rows, so the router (`delivery/router.py`) records the group
    here when a file arrives that does not complete it. The file that does
    complete it is written in a transaction that also deletes this row and
    stores the post's own events.

    A group whose files stop arriving is decided with the files that did,
    once `deadline` has passed (`MessageRouter.flush_due_groups`). Every
    switch-core process runs that sweep, and each claims a row with `FOR
    UPDATE SKIP LOCKED` and decides it in the transaction that deletes it, so
    one process decides each group whichever processes are running.
    `deadline` is set from the database's clock when the group's first file
    is written and never moved, so the wait bounds the whole group rather
    than the gap between two files.

    `from_seq` is the room row this group's files are counted from: the
    first file written since the group was last decided. A file that arrives
    after its group was decided incomplete starts a new row here, from
    itself, rather than completing a post that has already gone out.

    A reader of a room's conversation holds a group back while it has a row
    here, so the post is delivered as one message once it is decided.
    """

    __tablename__ = "pending_attachment_groups"
    __table_args__ = (
        # The sweep's question: which of a tenant's groups are due.
        Index("ix_pending_attachment_groups_deadline", "tenant_id", "deadline"),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_pending_attachment_groups_room",
            ondelete="CASCADE",
        ),
    )

    room_id: Mapped[str] = mapped_column(Text, primary_key=True)
    group_id: Mapped[str] = mapped_column(Text, primary_key=True)
    total: Mapped[int] = mapped_column(Integer, nullable=False)
    from_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    deadline: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class AgentRoomRead(TenantScoped, Base):
    """The baseline for an agent's unread count in one room, and who owns it.

    `caught_up_seq` is the `messages.seq` the agent had read through the last
    time it caught up on the room with `read_context`. The unaddressed
    messages after it are the `missed_count` the agent is shown.

    `occupant_id` is whoever is in the room for this agent now: a session id
    when `occupant_is_session` is true, a connection id otherwise. Only a
    catch-up by that occupant moves `caught_up_seq`, so a session that has
    left the room cannot clear the count of the one that replaced it.

    The row lives in Postgres so the count survives a restart and every
    server process reports the same number.
    """

    __tablename__ = "agent_room_reads"
    __table_args__ = (
        Index("ix_agent_room_reads_tenant_id", "tenant_id"),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_room_reads_agent",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_agent_room_reads_room",
            ondelete="CASCADE",
        ),
    )

    agent_id: Mapped[str] = mapped_column(Text, primary_key=True)
    room_id: Mapped[str] = mapped_column(Text, primary_key=True)
    caught_up_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    occupant_id: Mapped[str] = mapped_column(Text, nullable=False)
    occupant_is_session: Mapped[bool] = mapped_column(Boolean, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class AgentPollPosition(TenantScoped, Base):
    """How far a long-polling client has read, stored on its behalf.

    The long-poll endpoints take no position from the client, so the server
    remembers one for each kind of poll. `reader_id` names the poll:
    `legacy:all` for the agent-wide poll, `legacy:notifications` for the
    notifications poll, and `legacy:room:<room_id>` for a single room's poll.
    `position` is the state vector the next poll resumes from: `s` for the
    agent's own events and `r:<room_id>` for each room's conversation.
    """

    __tablename__ = "agent_poll_positions"
    __table_args__ = (
        Index("ix_agent_poll_positions_tenant_id", "tenant_id"),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_poll_positions_agent",
            ondelete="CASCADE",
        ),
    )

    agent_id: Mapped[str] = mapped_column(Text, primary_key=True)
    reader_id: Mapped[str] = mapped_column(Text, primary_key=True)
    position: Mapped[dict[str, int]] = mapped_column(JSONB, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


agent_position_ticket_sequence = Sequence(
    "agent_position_ticket",
    metadata=Base.metadata,
    # Ticket ids run from `TICKET_FLOOR` to `TICKET_CEILING`, above every own
    # event number (`agent_events.seq`) a client may also hold. The server
    # tells a ticket id from an own event number by size alone, and a client
    # that keeps the highest number it has seen never discards a ticket as
    # older. The range holds about four billion ids. The sequence starts again
    # at the floor when it runs out, which reuses only ids whose tickets the
    # retention loop deleted long before, since tickets last a day.
    start=TICKET_FLOOR,
    minvalue=TICKET_FLOOR,
    maxvalue=TICKET_CEILING,
    cycle=True,
)


class AgentPositionTicket(TenantScoped, Base):
    """A stored position, identified by a single number, for older clients.

    A reader's position is a state vector: `s` for how far it has read the
    agent's own events (`agent_events`) and `r:<room_id>` for how far it has
    read each room's conversation (`messages`). Clients on agent-protocol
    revision 8 or older can hold only one integer. When such a client reads the
    whole conversation, the server stores the position after each event it
    sends as a row here and sends the row's `id` as the event id. When the
    client resumes or beats with that id, the server looks the position up
    here.

    Clients on revision 9 send the position itself and never cause a row to
    be written. The retention loop deletes tickets older than
    `agent_event_retention_seconds`, the same window as the events they
    point into.
    """

    __tablename__ = "agent_position_tickets"
    __table_args__ = (
        Index("ix_agent_position_tickets_tenant_id", "tenant_id"),
        Index("ix_agent_position_tickets_created_at", "created_at"),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_position_tickets_agent",
            ondelete="CASCADE",
        ),
    )

    id: Mapped[int] = mapped_column(
        BigInteger,
        agent_position_ticket_sequence,
        primary_key=True,
        server_default=agent_position_ticket_sequence.next_value(),
    )
    agent_id: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[dict[str, int]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


#: The first connection incarnation the database hands out. Before agent
#: connections were recorded, each process drew incarnations from a counter
#: seeded with a random 32-bit number, so every number a client may still hold
#: from then is below 2**33 and none of them can match one drawn from here.
CONNECTION_INCARNATION_FLOOR = 2**33

#: The last one: every incarnation stays an integer a JavaScript client holds
#: exactly.
CONNECTION_INCARNATION_CEILING = 2**53 - 1

agent_connection_incarnation_sequence = Sequence(
    "agent_connection_incarnation",
    metadata=Base.metadata,
    start=CONNECTION_INCARNATION_FLOOR,
    minvalue=CONNECTION_INCARNATION_FLOOR,
    maxvalue=CONNECTION_INCARNATION_CEILING,
    cycle=False,
)


class AgentConnectionRecord(TenantScoped, Base):
    """An agent connection, as every switch-core process can see it.

    The connection itself (its socket, its heartbeat, the frames it is owed)
    lives in the memory of the process holding it (`agent_connections.py`).
    This row is what the other processes need to know about it: which process
    holds it (`process_id`, a `switch_core_processes` row), which incarnation
    is current, and what the client declared. It is written when the
    connection opens or is reattached and when it closes, never on a
    heartbeat, and it reads as live only while `closed_at` is null and the
    holding process's lease is held.

    `incarnation` comes from `agent_connection_incarnation`, so the fence a
    client names can be checked by any process, not only the one that issued
    it.
    """

    __tablename__ = "agent_connections"
    __table_args__ = (
        Index("ix_agent_connections_tenant_id", "tenant_id"),
        Index("ix_agent_connections_agent_id", "agent_id"),
        UniqueConstraint("id", "tenant_id", name="uq_agent_connections_id_tenant"),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_connections_agent",
            ondelete="CASCADE",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    agent_id: Mapped[str] = mapped_column(Text, nullable=False)
    process_id: Mapped[str] = mapped_column(Text, nullable=False)
    incarnation: Mapped[int] = mapped_column(BigInteger, nullable=False)
    scope: Mapped[str] = mapped_column(Text, nullable=False)
    delivery_filter: Mapped[str] = mapped_column(Text, nullable=False)
    spawn_capable: Mapped[bool] = mapped_column(Boolean, nullable=False)
    transport: Mapped[str] = mapped_column(Text, nullable=False)
    speaks: Mapped[int | None] = mapped_column(Integer, nullable=True)
    accepts: Mapped[int | None] = mapped_column(Integer, nullable=True)
    attached_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    closed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    close_reason: Mapped[str | None] = mapped_column(Text, nullable=True)


class AgentConnectionRoom(TenantScoped, Base):
    """A room explicitly claimed on an agent connection.

    The primary key is the rule that at most one connection of an agent acts
    in a room, kept by the database so that two processes claiming the same
    room for the same agent cannot both succeed. A claim counts only while its
    connection's row is live.
    """

    __tablename__ = "agent_connection_rooms"
    __table_args__ = (
        Index("ix_agent_connection_rooms_tenant_id", "tenant_id"),
        Index("ix_agent_connection_rooms_connection_id", "connection_id"),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_connection_rooms_agent",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_agent_connection_rooms_room",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "connection_id"],
            ["agent_connections.tenant_id", "agent_connections.id"],
            name="fk_agent_connection_rooms_connection",
            ondelete="CASCADE",
        ),
    )

    agent_id: Mapped[str] = mapped_column(Text, primary_key=True)
    room_id: Mapped[str] = mapped_column(Text, primary_key=True)
    connection_id: Mapped[str] = mapped_column(Text, nullable=False)


class AgentSessionPlacement(TenantScoped, Base):
    """Which room one of an agent's sessions connected to, and over which
    connection.

    A session placed itself with `connect_to_room`, or its watcher stated it
    with `/connection/placements`. One session of an agent acts in a room, so
    a room appears once per agent. The placement belongs to the connection it
    arrived on and goes with that connection's row.
    """

    __tablename__ = "agent_session_placements"
    __table_args__ = (
        Index("ix_agent_session_placements_tenant_id", "tenant_id"),
        Index("ix_agent_session_placements_connection_id", "connection_id"),
        UniqueConstraint(
            "agent_id", "room_id", name="uq_agent_session_placements_agent_room"
        ),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_session_placements_agent",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_agent_session_placements_room",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "connection_id"],
            ["agent_connections.tenant_id", "agent_connections.id"],
            name="fk_agent_session_placements_connection",
            ondelete="CASCADE",
        ),
    )

    agent_id: Mapped[str] = mapped_column(Text, primary_key=True)
    session_id: Mapped[str] = mapped_column(Text, primary_key=True)
    room_id: Mapped[str] = mapped_column(Text, nullable=False)
    connection_id: Mapped[str] = mapped_column(Text, nullable=False)


class AgentSessionCommandRelay(TenantScoped, Base):
    """A session command waiting for the process that can deliver it.

    A command for one of an agent's sessions (from Switch Console, or a Stop
    pressed on a bridge) can arrive at any process, while the stream it must
    be written to (the agent's watcher, or its controller's) is held by one.
    The command is stored here for that process (`process_id`) and the process
    is told to look; it deletes the row as it takes the command. The signal
    carries only ids, because a command's content is tenant data and a
    `NOTIFY` is readable by any listener.
    """

    __tablename__ = "agent_session_command_relays"
    __table_args__ = (
        Index("ix_agent_session_command_relays_tenant_id", "tenant_id"),
        Index("ix_agent_session_command_relays_process_id", "process_id"),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_session_command_relays_agent",
            ondelete="CASCADE",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    agent_id: Mapped[str] = mapped_column(Text, nullable=False)
    process_id: Mapped[str] = mapped_column(Text, nullable=False)
    frame: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
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


# ── Chats ─────────────────────────────────────────────────────────────────────


class ChatOperation(TenantScoped, Base):
    """A Switch Console request a person may retry, keyed by their request id.

    The same key with the same payload answers what the first attempt did; the
    same key with a different payload is refused. `pending` is only ever seen
    on a chat creation, which spans several transactions: a send and an upload
    commit their effect and this row together, so they are `done` or absent.
    """

    __tablename__ = "chat_operations"
    __table_args__ = (
        PrimaryKeyConstraint("tenant_id", "user_id", "request_id"),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_chat_operations_room",
            ondelete="CASCADE",
        ),
        CheckConstraint(
            "kind IN ('create_chat', 'send', 'upload', 'control')",
            name="ck_chat_operations_kind",
        ),
        CheckConstraint(
            "state IN ('pending', 'done')", name="ck_chat_operations_state"
        ),
    )

    user_id: Mapped[str] = mapped_column(
        Text,
        ForeignKey("users.id", ondelete="CASCADE", name="fk_chat_operations_user"),
        nullable=False,
    )
    request_id: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    payload_hash: Mapped[str] = mapped_column(Text, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    room_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class ChatHidden(TenantScoped, Base):
    """A chat one person took off their own list, until something new is said.

    `hidden_through_seq` is the room's position when it was hidden; a message
    after it brings the chat back.
    """

    __tablename__ = "chat_hidden"
    __table_args__ = (
        PrimaryKeyConstraint("tenant_id", "user_id", "room_id"),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_chat_hidden_room",
            ondelete="CASCADE",
        ),
    )

    user_id: Mapped[str] = mapped_column(
        Text,
        ForeignKey("users.id", ondelete="CASCADE", name="fk_chat_hidden_user"),
        nullable=False,
    )
    room_id: Mapped[str] = mapped_column(Text, nullable=False)
    hidden_through_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ChatRead(TenantScoped, Base):
    """How far one person has read a chat: the last room position they were
    shown. Only moves forward; set to the room's head as they join, so what
    was said before they arrived is not unread."""

    __tablename__ = "chat_reads"
    __table_args__ = (
        PrimaryKeyConstraint("tenant_id", "user_id", "room_id"),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_chat_reads_room",
            ondelete="CASCADE",
        ),
    )

    user_id: Mapped[str] = mapped_column(
        Text,
        ForeignKey("users.id", ondelete="CASCADE", name="fk_chat_reads_user"),
        nullable=False,
    )
    room_id: Mapped[str] = mapped_column(Text, nullable=False)
    read_through_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ChatOwnerGrant(TenantScoped, Base):
    """A membership held only because the person owns an agent in the room.

    Present while that is the sole reason: it goes with the membership when
    they no longer own an agent there, and is dropped (making the membership
    lasting) when they are invited, create the chat, or join as a manager.
    """

    __tablename__ = "chat_owner_grants"
    __table_args__ = (
        PrimaryKeyConstraint("tenant_id", "user_id", "room_id"),
        ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_chat_owner_grants_room",
            ondelete="CASCADE",
        ),
    )

    user_id: Mapped[str] = mapped_column(
        Text,
        ForeignKey("users.id", ondelete="CASCADE", name="fk_chat_owner_grants_user"),
        nullable=False,
    )
    room_id: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
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

# The trigger that signals every process when a client's membership changes,
# so each process's copy of that client starts or stops reading the room. As
# above, `create_all` builds it for the tests; real databases get it from a
# migration. The SQL lives in `db/membership_notify_ddl.py`.
for _ddl in (CREATE_MEMBERSHIP_NOTIFY_FUNCTION, CREATE_MEMBERSHIP_NOTIFY_TRIGGER):
    event.listen(
        ClientRoom.__table__, "after_create", DDL(_ddl).execute_if(dialect="postgresql")
    )
event.listen(
    ClientRoom.__table__,
    "before_drop",
    DDL(DROP_MEMBERSHIP_NOTIFY_TRIGGER).execute_if(dialect="postgresql"),
)

# These attach the trigger that sends a Postgres `NOTIFY` on channel
# `switch_agent_event` for every new `agent_events` row, so the server process
# waiting to deliver that agent's events wakes up. They run only when
# `metadata.create_all` builds the schema, which the tests do. Real databases
# get the same trigger from migration a7e3c1d9f204. The SQL lives in
# `db/agent_event_notify_ddl.py`.
event.listen(
    AgentEventRow.__table__,
    "after_create",
    DDL(CREATE_AGENT_EVENT_NOTIFY_FUNCTION).execute_if(dialect="postgresql"),
)
event.listen(
    AgentEventRow.__table__,
    "after_create",
    DDL(CREATE_AGENT_EVENT_NOTIFY_TRIGGER).execute_if(dialect="postgresql"),
)
event.listen(
    AgentEventRow.__table__,
    "before_drop",
    DDL(DROP_AGENT_EVENT_NOTIFY_TRIGGER).execute_if(dialect="postgresql"),
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


class AgentSessionActivityItem(TenantScoped, Base):
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
    (AgentSessionActivityItem.__table__, (CREATE_ACTIVITY_TRIGGER,)),
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
        Index("ix_usage_budgets_tenant_id", "tenant_id"),
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


# ── Agent management ──────────────────────────────────────────────────────────

# `api_keys.type` values that hold a hash and nothing else. Nothing may decrypt
# them, so their `encrypted_key` is the empty string, and they are neither
# listed nor revealable through the user's API-key routes.
CONTROLLER_KEY_TYPE = "controller"
CONTROLLER_ENROLLMENT_KEY_TYPE = "controller_enrollment"
HASH_ONLY_KEY_TYPES = frozenset({CONTROLLER_KEY_TYPE, CONTROLLER_ENROLLMENT_KEY_TYPE})


class AgentController(TenantScoped, Base):
    """A machine that runs managed agents on behalf of its owner.

    `api_key_id` is the controller's long-lived credential, an `api_keys` row of
    type `controller` holding the hash only. It is null once the controller is
    revoked, and also if the key is deleted from under it (removing a member
    deletes every key they hold), which is treated the same as revocation. `status` is the last accepted status report verbatim and
    `status_seq` its sequence number: a report with a sequence at or below it is
    ignored. `assignment_revision` bumps on every change to the set of agents
    the controller should run, and is what its ETag carries.

    The `connection_*`, `connected_at` and `disconnect*` columns are the
    controller's socket as the switch-core process holding it last recorded it
    (`management/connection_ledger.py`): which connection, which process holds
    it (`connection_process_id`, a `switch_core_processes` row), when its
    socket attached, and when and why it went. Only transitions are written,
    never heartbeats; a process that dies without writing the closing is
    caught by its lease in `switch_core_processes` going stale. They describe
    the current connection, or the last one once it has closed; a new one
    replaces them. Every replica reads them, so whether the machine is
    connected does not depend on which process holds its socket.

    The `open_*` columns are the connection the controller last opened,
    attached or not: its id, its generation, the process holding it and where
    its stream resumes each agent. Opening and attaching the socket are two
    requests that may reach two processes, as may a socket reattaching after a
    drop, so the process the socket reaches reads them to hold the connection
    itself, and records that it does. Written when the connection opens, when
    another process takes it up and, for the cursors, when its socket goes;
    never per heartbeat.
    """

    __tablename__ = "agent_controllers"
    __table_args__ = (
        UniqueConstraint("id", "tenant_id", name="uq_agent_controllers_id_tenant"),
        ForeignKeyConstraint(
            ["tenant_id", "api_key_id"],
            ["api_keys.tenant_id", "api_keys.id"],
            name="fk_agent_controllers_api_key",
            ondelete="SET NULL (api_key_id)",
        ),
        CheckConstraint(
            "kind IN ('console', 'daemon', 'ec2')", name="ck_agent_controllers_kind"
        ),
        Index("ix_agent_controllers_owner_id", "owner_id"),
        Index("ix_agent_controllers_tenant_id", "tenant_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    owner_id: Mapped[str] = mapped_column(Text, ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # What the owner says the machine is for; free text, optional.
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    platform: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    version: Mapped[str | None] = mapped_column(Text, nullable=True)
    public_key: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    api_key_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    assignment_revision: Mapped[int] = mapped_column(
        Integer, server_default=text("0"), nullable=False
    )
    status_seq: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    status: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    connection_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Not a foreign key: a lease row is pruned once long stale, and a
    # connection naming a process with no lease reads as lost.
    connection_process_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    connected_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    disconnected_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # `socket_closed`, `heartbeat_lapsed`, `taken_over`, `revoked` or
    # `server_shutdown`.
    disconnect_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    open_connection_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    open_generation: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # The process holding that connection: the one that opened it, or the one
    # its socket reached since. Any other process holding a copy closes it.
    open_process_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Agent id to the cursor its delivery resumes after, or null for the head.
    open_cursors: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class AgentControllerEnrollmentCode(TenantScoped, Base):
    """A one-time code a headless controller enrolls with.

    The code itself is an `api_keys` row of type `controller_enrollment`, so the
    global hash-to-tenant lookup resolves it before any tenant is bound, exactly
    as it does a bearer credential. That row is deleted when the code is used,
    leaving `api_key_id` null and `controller_id` naming what it enrolled.
    """

    __tablename__ = "agent_controller_enrollment_codes"
    __table_args__ = (
        ForeignKeyConstraint(
            ["tenant_id", "api_key_id"],
            ["api_keys.tenant_id", "api_keys.id"],
            name="fk_agent_controller_enrollment_codes_api_key",
            ondelete="SET NULL (api_key_id)",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "controller_id"],
            ["agent_controllers.tenant_id", "agent_controllers.id"],
            name="fk_agent_controller_enrollment_codes_controller",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "machine_workspace_id"],
            ["machine_workspaces.tenant_id", "machine_workspaces.id"],
            name="fk_agent_controller_enrollment_codes_machine_workspace",
        ),
        Index("ix_agent_controller_enrollment_codes_tenant_id", "tenant_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    owner_id: Mapped[str] = mapped_column(Text, ForeignKey("users.id"), nullable=False)
    api_key_id: Mapped[str | None] = mapped_column(Text, nullable=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    controller_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Set for a code minted for a Switch cloud machine: what enrolls with it
    # is that machine's controller.
    machine_workspace_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class AgentDefinition(TenantScoped, Base):
    """What a managed agent is, and which controller runs it.

    One per agent. `controller_id` null means the agent is managed but placed
    nowhere. `revision` bumps on every change to the definition, its desired
    state or its placement; controllers use it to fence out stale revisions.
    `definition` is the v1 definition document (provider, model, instructions,
    auto_mode, auto_approve, directory); a document stored before `auto_mode`
    existed lacks it, which reads as off.
    """

    __tablename__ = "agent_definitions"
    __table_args__ = (
        UniqueConstraint("tenant_id", "agent_id", name="uq_agent_definitions_agent"),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_definitions_agent",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "controller_id"],
            ["agent_controllers.tenant_id", "agent_controllers.id"],
            name="fk_agent_definitions_controller",
        ),
        CheckConstraint(
            "desired_state IN ('running', 'stopped')",
            name="ck_agent_definitions_desired_state",
        ),
        Index("ix_agent_definitions_controller_id", "controller_id"),
        Index("ix_agent_definitions_owner_id", "owner_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    agent_id: Mapped[str] = mapped_column(Text, nullable=False)
    owner_id: Mapped[str] = mapped_column(Text, ForeignKey("users.id"), nullable=False)
    controller_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    desired_state: Mapped[str] = mapped_column(Text, nullable=False)
    definition: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class AgentControllerOperation(TenantScoped, Base):
    """An explicit action for a controller to carry out, outside desired state.

    A controller claims a pending operation and holds it under a lease
    (`lease_expires_at`); an operation still `claimed` after its lease has
    lapsed is offered again. `kind` is not checked here, because the set grows
    with the protocol; Management refuses the kinds it does not support.
    """

    __tablename__ = "agent_controller_operations"
    __table_args__ = (
        ForeignKeyConstraint(
            ["tenant_id", "controller_id"],
            ["agent_controllers.tenant_id", "agent_controllers.id"],
            name="fk_agent_controller_operations_controller",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_controller_operations_agent",
            ondelete="CASCADE",
        ),
        CheckConstraint(
            "state IN ('pending', 'claimed', 'succeeded', 'failed', 'cancelled', 'expired')",
            name="ck_agent_controller_operations_state",
        ),
        Index(
            "ix_agent_controller_operations_controller_state",
            "controller_id",
            "state",
        ),
        Index("ix_agent_controller_operations_tenant_id", "tenant_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    controller_id: Mapped[str] = mapped_column(Text, nullable=False)
    agent_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    params: Mapped[dict] = mapped_column(JSONB, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_by: Mapped[str] = mapped_column(
        Text, ForeignKey("users.id"), nullable=False
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


class SealedProviderLogin(TenantScoped, Base):
    """A provider login for one controller, sealed to that controller's own
    public key (`AgentController.public_key`) by the owner's client before it
    reached Switch.

    Switch keeps and relays the ciphertext and can never open it: only the
    controller holding the private key can. One per controller and provider;
    `revision` grows with each new one, so the controller can tell a changed
    login from the one it already applied. Removed with its controller, and
    when the controller is revoked.
    """

    __tablename__ = "sealed_provider_logins"
    __table_args__ = (
        ForeignKeyConstraint(
            ["tenant_id", "controller_id"],
            ["agent_controllers.tenant_id", "agent_controllers.id"],
            name="fk_sealed_provider_logins_controller",
            ondelete="CASCADE",
        ),
        Index("ix_sealed_provider_logins_tenant_id", "tenant_id"),
    )

    controller_id: Mapped[str] = mapped_column(Text, primary_key=True)
    provider: Mapped[str] = mapped_column(Text, primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    # `{alg, key_id, ephemeral_key, nonce, ciphertext}`; see
    # `management/sealed_logins.py`.
    sealed: Mapped[dict] = mapped_column(JSONB, nullable=False)
    sealed_by: Mapped[str] = mapped_column(Text, ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


# ── Service connections ──────────────────────────────────────────────────────


class ServiceConnection(TenantScoped, Base):
    """One person's sign-in to an outside service, in one workspace.

    `service` is a catalog slug (`connections/catalog/`), checked in code
    rather than by the database, so a new service needs no migration.
    `encrypted_secret` is keyring-encrypted JSON: the refresh token and the
    cached access token, each with its expiry. Only the credential broker
    (`connections/broker.py`) decrypts it, and `secret_revision` bumps on every
    write of it. `account_id` is the vendor's stable id for the account, so a
    grant made for one account is not used for another after a re-link.
    """

    __tablename__ = "service_connections"
    __table_args__ = (
        PrimaryKeyConstraint("tenant_id", "user_id", "service"),
        # One Switch user per vendor account in a workspace.
        UniqueConstraint(
            "tenant_id", "service", "account_id", name="uq_service_connections_account"
        ),
        CheckConstraint(
            "status IN ('active', 'needs_reauthorization', 'error')",
            name="ck_service_connections_status",
        ),
        CheckConstraint(
            "consent IN ('read', 'write')", name="ck_service_connections_consent"
        ),
    )

    user_id: Mapped[str] = mapped_column(
        Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    service: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    consent: Mapped[str] = mapped_column(Text, nullable=False)
    granted_scopes: Mapped[list] = mapped_column(JSONB, nullable=False)
    account_id: Mapped[str] = mapped_column(Text, nullable=False)
    external_identity: Mapped[str] = mapped_column(Text, nullable=False)
    encrypted_secret: Mapped[str] = mapped_column(Text, nullable=False)
    secret_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The OAuth client the sign-in went through, so a connection made through
    # a client the operator has since replaced is known to need reconnecting.
    # Null for a key, and for a sign-in made before it was recorded.
    oauth_client_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class SignInFlow(TenantScoped, Base):
    """A person part-way through signing in to a service from Switch Console.

    A sign-in is half a dozen requests, from Console and from the person's
    browser, and with several switch-core processes behind one address each
    can land on any of them, so the flow lives here rather than in the memory
    of the process that started it (`connections/sign_in_flows.py`).

    `id` is the state Console chose for the flow, which travels in the
    vendor's redirect, so the browser's requests find the flow by it and the
    flow's tenant through `tenant_of_sign_in_flow`. `kind` is `github` for the
    GitHub App's own sign-in and `service` for the catalog's OAuth sign-ins:
    a person has at most one flow of each kind at a time. `status` moves by
    conditional update only, so of two requests racing for one step exactly
    one takes it.

    Nothing secret is stored in the clear: the PKCE verifier is
    keyring-encrypted, and the completion secret and browser nonce are kept as
    SHA-256 hashes, compared against what Console and the browser present.
    The vendor's credentials never reach the row: the request that exchanges
    the code writes the connection, and the flow then holds the outcome
    (`account_label`, `warning` or `error`) for Console to read until it drops
    the flow. `encrypted_result` held those credentials between the exchange
    and a confirm step that is gone; it stays for a release that still writes
    it. `details` holds what the flow asked the vendor for (its name, scopes
    and consent), none of it secret. Rows expire after ten minutes, and
    expired ones are deleted as the next flow in the workspace starts.
    """

    __tablename__ = "sign_in_flows"
    __table_args__ = (
        CheckConstraint("kind IN ('github', 'service')", name="ck_sign_in_flows_kind"),
        CheckConstraint(
            "status IN ('pending', 'authorizing', 'returning', 'delivered', "
            "'checking', 'ready', 'connected', 'failed')",
            name="ck_sign_in_flows_status",
        ),
        CheckConstraint("mode IN ('loopback', 'core')", name="ck_sign_in_flows_mode"),
        Index("ix_sign_in_flows_user", "tenant_id", "user_id", "kind"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    service: Mapped[str] = mapped_column(Text, nullable=False)
    user_id: Mapped[str] = mapped_column(
        Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(Text, nullable=False)
    mode: Mapped[str] = mapped_column(Text, nullable=False)
    port: Mapped[int] = mapped_column(Integer, nullable=False)
    redirect_uri: Mapped[str] = mapped_column(Text, nullable=False)
    owner_label: Mapped[str] = mapped_column(Text, nullable=False)
    details: Mapped[dict] = mapped_column(JSONB, nullable=False)
    encrypted_verifier: Mapped[str] = mapped_column(Text, nullable=False)
    completion_secret_hash: Mapped[str] = mapped_column(Text, nullable=False)
    browser_nonce_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    encrypted_result: Mapped[str | None] = mapped_column(Text, nullable=True)
    account_label: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    warning: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )


class ServiceOAuthClient(Base):
    """The OAuth client Core registered for itself at a service's vendor.

    Dynamic client registration (RFC 7591), for a vendor that offers no other
    way to have a client: one row per deployment and service, written on the
    first connect. Deployment-wide, because the vendor sees one Switch, and
    every workspace's connections sign in through it. `encrypted_secret` is
    keyring-encrypted JSON of the vendor's registration answer, its
    `client_secret` included where the vendor issued one;
    `registration_endpoint` is where it was registered, so a vendor that moves
    it gets a new registration rather than an unknown client.
    """

    __tablename__ = "service_oauth_clients"

    service: Mapped[str] = mapped_column(Text, primary_key=True)
    registration_endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    oauth_client_id: Mapped[str] = mapped_column(Text, nullable=False)
    encrypted_secret: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ServiceAppCredential(Base):
    """The app the operator registered at a service's vendor, for the whole server.

    A GitHub App or a static OAuth client, entered from the dashboard rather
    than a settings file (`connections/app_credentials.py`). One row per
    deployment and service, as `ServiceOAuthClient` is: the vendor sees one
    Switch. `service` is a catalog slug, checked in code. `client_id` and
    `settings` (non-secret extras, such as a GitHub App's slug) are kept in the
    clear; `encrypted_secrets` is keyring-encrypted JSON of every secret the
    kind has, so a kind with more secrets needs no migration.
    """

    __tablename__ = "service_app_credentials"

    service: Mapped[str] = mapped_column(Text, primary_key=True)
    client_id: Mapped[str] = mapped_column(Text, nullable=False)
    settings: Mapped[dict] = mapped_column(JSONB, nullable=False)
    encrypted_secrets: Mapped[str] = mapped_column(Text, nullable=False)
    updated_by: Mapped[str] = mapped_column(
        Text, ForeignKey("users.id"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ServerAuditEvent(Base):
    """One change to the server as a whole: who did what, to what, when.

    `AuditEvent` records a tenant's history; a change no tenant owns, such as
    the operator setting up a connector's app, has no tenant to be filed
    under, so it lands here. The same shape and the same rules: append-only
    for the runtime role (`grant_runtime_role`), `actor_user_id` with no
    foreign key so the history outlives the account, and `details` holding
    identifiers and field names, never a secret.
    """

    __tablename__ = "server_audit_events"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp(), nullable=False
    )
    actor_user_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    target_type: Mapped[str] = mapped_column(Text, nullable=False)
    target_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    details: Mapped[dict | None] = mapped_column(JSONB, nullable=True)


class WorkspaceServiceSetting(TenantScoped, Base):
    """A workspace admin switched a catalog service on or off for the workspace.

    No row means the workspace's default (`Tenant.services_on_by_default`),
    off for a workspace made since services started off: a row is written
    only when an admin touches the switch,
    so `updated_by` always names a person. `service` is a catalog slug, checked
    in code as `ServiceConnection.service` is. Off, nobody in the workspace can
    connect, grant or be issued a token for it, and its grants drop out of
    what agents' sessions are given; the grants themselves are kept.
    """

    __tablename__ = "workspace_service_settings"
    __table_args__ = (PrimaryKeyConstraint("tenant_id", "service"),)

    service: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    updated_by: Mapped[str] = mapped_column(
        Text, ForeignKey("users.id"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class ServiceGrant(TenantScoped, Base):
    """An agent may use its owner's connection to a service.

    The connection is named by (`owner_id`, `service`), so a grant can only
    ever point at its owner's own connection, and disconnecting removes the
    grants with it; re-linking updates the connection in place and keeps
    them. `account_id` is the connection's account when the grant was made.
    `tool_mode` `allow` means only `tools`; `deny` means every tool of the
    access level except `tools`. `revision` moves on every change to the grant,
    so a token being issued as it moves is taken back rather than recorded.
    """

    __tablename__ = "service_grants"
    __table_args__ = (
        PrimaryKeyConstraint("tenant_id", "id"),
        UniqueConstraint(
            "tenant_id", "agent_id", "service", name="uq_service_grants_agent_service"
        ),
        ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_service_grants_agent",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "owner_id", "service"],
            [
                "service_connections.tenant_id",
                "service_connections.user_id",
                "service_connections.service",
            ],
            name="fk_service_grants_connection",
            ondelete="CASCADE",
        ),
        # The cascade from a disconnect, and every grant lookup by connection.
        Index("ix_service_grants_connection", "tenant_id", "owner_id", "service"),
        CheckConstraint("access IN ('read', 'write')", name="ck_service_grants_access"),
        CheckConstraint(
            "tool_mode IN ('allow', 'deny')", name="ck_service_grants_tool_mode"
        ),
    )

    id: Mapped[str] = mapped_column(Text, nullable=False, default=_uuid)
    agent_id: Mapped[str] = mapped_column(Text, nullable=False)
    owner_id: Mapped[str] = mapped_column(Text, nullable=False)
    service: Mapped[str] = mapped_column(Text, nullable=False)
    access: Mapped[str] = mapped_column(Text, nullable=False)
    tool_mode: Mapped[str] = mapped_column(Text, nullable=False)
    tools: Mapped[list] = mapped_column(JSONB, nullable=False)
    resources: Mapped[dict] = mapped_column(JSONB, nullable=False)
    account_id: Mapped[str] = mapped_column(Text, nullable=False)
    revision: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("1")
    )
    created_by: Mapped[str] = mapped_column(
        Text, ForeignKey("users.id"), nullable=False
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


class ServiceTokenIssuance(TenantScoped, Base):
    """A record of one token Core issued to an agent for a service.

    No foreign keys, so the record outlives the grant, the agent and the
    person. `encrypted_token` is held only where the vendor can revoke a single
    token (GitHub), and only while the token is live: it is cleared once the
    token has expired or been revoked. `token_sha256` stays, so a leaked token
    can be traced to the agent it was issued to. Records are pruned after
    `service_token_retention_days`.

    `revoke_requested` on a token held without its ciphertext from the start
    (the owner's own, passed through) means its access was withdrawn while it
    was live: nothing can revoke it, and it stays valid until `expires_at`.
    """

    __tablename__ = "service_token_issuances"
    __table_args__ = (
        PrimaryKeyConstraint("tenant_id", "id"),
        CheckConstraint(
            "principal IN ('controller', 'agent_key')",
            name="ck_service_token_issuances_principal",
        ),
        Index("ix_service_token_issuances_created_at", "tenant_id", "created_at"),
        # The tokens that can still be revoked: every revocation queue and
        # claim reads only these, a few hours' worth at most.
        Index(
            "ix_service_token_issuances_live",
            "tenant_id",
            "expires_at",
            postgresql_where=text("encrypted_token IS NOT NULL"),
        ),
        # The tokens that cannot be revoked, for marking the ones still live
        # when their access is withdrawn.
        Index(
            "ix_service_token_issuances_unrevocable",
            "tenant_id",
            "expires_at",
            postgresql_where=text("encrypted_token IS NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, nullable=False, default=_uuid)
    grant_id: Mapped[str] = mapped_column(Text, nullable=False)
    agent_id: Mapped[str] = mapped_column(Text, nullable=False)
    owner_id: Mapped[str] = mapped_column(Text, nullable=False)
    service: Mapped[str] = mapped_column(Text, nullable=False)
    principal: Mapped[str] = mapped_column(Text, nullable=False)
    controller_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    permissions: Mapped[dict] = mapped_column(JSONB, nullable=False)
    resources: Mapped[dict] = mapped_column(JSONB, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    token_sha256: Mapped[str] = mapped_column(Text, nullable=False)
    encrypted_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    revoke_requested: Mapped[bool] = mapped_column(Boolean, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False)
    claim_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class TenantDataMove(TenantScoped, Base):
    """A one-time data move that has been carried out in this tenant.

    Written in the same transaction as the move itself, and read before it, so
    a move runs once per tenant: never again on a later boot, where it would
    undo what people changed since. `details` counts what was moved and what
    was skipped.
    """

    __tablename__ = "tenant_data_moves"
    __table_args__ = (PrimaryKeyConstraint("tenant_id", "name"),)

    name: Mapped[str] = mapped_column(Text, nullable=False)
    details: Mapped[dict] = mapped_column(JSONB, nullable=False)
    completed_at: Mapped[datetime] = mapped_column(
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
