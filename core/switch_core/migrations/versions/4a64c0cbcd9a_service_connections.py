"""service connections: connections, grants and issued-token records

Three tenant-scoped tables for connecting a person's own accounts on outside
services and granting them to that person's agents:

- `service_connections`, one person's sign-in to one service, keyed by
  tenant, user and service, with one link per vendor account in a tenant.
  The secret is keyring-encrypted JSON.
- `service_grants`, an agent's use of its owner's connection. Its key to the
  connection is (tenant, owner, service), so disconnecting removes the grants
  and a grant can never name another person's connection.
- `service_token_issuances`, a record of every token issued, with no foreign
  keys so it outlives the grant, the agent and the person.

Nothing reads or writes them yet outside the credential broker, and no
service is enabled on it, so a deployment sees no change.

The row-level-security DDL is a verbatim copy of `switch_core/db/rls_ddl.py`
as it stood when this migration was written, copied rather than imported for
the reason `265ed188ad6f` gives.

Revision ID: 4a64c0cbcd9a
Revises: eb24eafa59a0
Create Date: 2026-10-06 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "4a64c0cbcd9a"
down_revision: str | Sequence[str] | None = "eb24eafa59a0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"

TABLES = (
    "service_connections",
    "service_grants",
    "service_token_issuances",
)

_PREDICATE = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'


def _create_policy(table: str) -> str:
    return (
        f'CREATE POLICY {POLICY_NAME} ON "{table}"\n'
        f"    FOR ALL\n"
        f"    USING ({_PREDICATE})\n"
        f"    WITH CHECK ({_PREDICATE})"
    )


def _timestamp(name: str) -> sa.Column:
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        server_default=sa.text("now()"),
        nullable=False,
    )


def upgrade() -> None:
    op.create_table(
        "service_connections",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("service", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("consent", sa.Text(), nullable=False),
        sa.Column("granted_scopes", postgresql.JSONB(), nullable=False),
        sa.Column("account_id", sa.Text(), nullable=False),
        sa.Column("external_identity", sa.Text(), nullable=False),
        sa.Column("encrypted_secret", sa.Text(), nullable=False),
        sa.Column("secret_revision", sa.Integer(), nullable=False),
        sa.Column("error_code", sa.Text(), nullable=True),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.PrimaryKeyConstraint("tenant_id", "user_id", "service"),
        sa.UniqueConstraint(
            "tenant_id",
            "service",
            "account_id",
            name="uq_service_connections_account",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_service_connections_tenant"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.CheckConstraint(
            "status IN ('active', 'needs_reauthorization', 'error')",
            name="ck_service_connections_status",
        ),
        sa.CheckConstraint(
            "consent IN ('read', 'write')", name="ck_service_connections_consent"
        ),
    )

    op.create_table(
        "service_grants",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.Text(), nullable=False),
        sa.Column("service", sa.Text(), nullable=False),
        sa.Column("access", sa.Text(), nullable=False),
        sa.Column("tool_mode", sa.Text(), nullable=False),
        sa.Column("tools", postgresql.JSONB(), nullable=False),
        sa.Column("resources", postgresql.JSONB(), nullable=False),
        sa.Column("account_id", sa.Text(), nullable=False),
        sa.Column("created_by", sa.Text(), nullable=False),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.PrimaryKeyConstraint("tenant_id", "id"),
        sa.UniqueConstraint(
            "tenant_id", "agent_id", "service", name="uq_service_grants_agent_service"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_service_grants_tenant"
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_service_grants_agent",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "owner_id", "service"],
            [
                "service_connections.tenant_id",
                "service_connections.user_id",
                "service_connections.service",
            ],
            name="fk_service_grants_connection",
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "access IN ('read', 'write')", name="ck_service_grants_access"
        ),
        sa.CheckConstraint(
            "tool_mode IN ('allow', 'deny')", name="ck_service_grants_tool_mode"
        ),
    )
    op.create_index(
        "ix_service_grants_connection",
        "service_grants",
        ["tenant_id", "owner_id", "service"],
    )

    op.create_table(
        "service_token_issuances",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("grant_id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.Text(), nullable=False),
        sa.Column("service", sa.Text(), nullable=False),
        sa.Column("principal", sa.Text(), nullable=False),
        sa.Column("controller_id", sa.Text(), nullable=True),
        sa.Column("permissions", postgresql.JSONB(), nullable=False),
        sa.Column("resources", postgresql.JSONB(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("token_sha256", sa.Text(), nullable=False),
        sa.Column("encrypted_token", sa.Text(), nullable=True),
        sa.Column("revoke_requested", sa.Boolean(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("claim_until", sa.DateTime(timezone=True), nullable=True),
        _timestamp("created_at"),
        sa.PrimaryKeyConstraint("tenant_id", "id"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_service_token_issuances_tenant"
        ),
        sa.CheckConstraint(
            "principal IN ('controller', 'agent_key')",
            name="ck_service_token_issuances_principal",
        ),
    )
    op.create_index(
        "ix_service_token_issuances_created_at",
        "service_token_issuances",
        ["tenant_id", "created_at"],
    )
    op.create_index(
        "ix_service_token_issuances_live",
        "service_token_issuances",
        ["tenant_id", "expires_at"],
        postgresql_where=sa.text("encrypted_token IS NOT NULL"),
    )

    for table in TABLES:
        op.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
        op.execute(_create_policy(table))


def downgrade() -> None:
    for table in reversed(TABLES):
        op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{table}"')
    op.drop_index(
        "ix_service_token_issuances_live", table_name="service_token_issuances"
    )
    op.drop_index(
        "ix_service_token_issuances_created_at", table_name="service_token_issuances"
    )
    op.drop_table("service_token_issuances")
    op.drop_index("ix_service_grants_connection", table_name="service_grants")
    op.drop_table("service_grants")
    op.drop_table("service_connections")
