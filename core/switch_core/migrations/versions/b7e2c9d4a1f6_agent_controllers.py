"""agent management: controllers, enrollment codes, definitions and operations

Four tenant-scoped tables behind `AGENT_MANAGEMENT_ENABLED`:

- `agent_controllers`, the machines that run managed agents. A controller's
  credential is an `api_keys` row of type `controller` holding the hash only.
- `agent_controller_enrollment_codes`, one-time codes a headless controller
  enrolls with. Each code is an `api_keys` row of type `controller_enrollment`,
  so the existing hash-to-tenant lookup resolves it with no new exemption.
- `agent_definitions`, one per managed agent: its definition, desired state
  and the controller it is placed on.
- `agent_controller_operations`, explicit actions a controller claims under a
  lease.

Nothing changes for a deployment with the flag off: the tables are empty and
no route reads them.

The row-level-security DDL is a verbatim copy of `switch_core/db/rls_ddl.py`
as it stood when this migration was written, copied rather than imported for
the reason `265ed188ad6f` gives.

Revision ID: b7e2c9d4a1f6
Revises: 13d5ddc9829d
Create Date: 2026-10-02 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b7e2c9d4a1f6"
down_revision: str | Sequence[str] | None = "13d5ddc9829d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"

TABLES = (
    "agent_controllers",
    "agent_controller_enrollment_codes",
    "agent_definitions",
    "agent_controller_operations",
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
        "agent_controllers",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("platform", postgresql.JSONB(), nullable=True),
        sa.Column("version", sa.Text(), nullable=True),
        sa.Column("public_key", postgresql.JSONB(), nullable=True),
        sa.Column("api_key_id", sa.Text(), nullable=True),
        sa.Column(
            "assignment_revision",
            sa.Integer(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column("status_seq", sa.BigInteger(), nullable=True),
        sa.Column("status", postgresql.JSONB(), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "tenant_id", name="uq_agent_controllers_id_tenant"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_agent_controllers_tenant"
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.ForeignKeyConstraint(
            ["tenant_id", "api_key_id"],
            ["api_keys.tenant_id", "api_keys.id"],
            name="fk_agent_controllers_api_key",
            ondelete="SET NULL (api_key_id)",
        ),
        sa.CheckConstraint(
            "kind IN ('console', 'daemon', 'ec2')", name="ck_agent_controllers_kind"
        ),
    )
    op.create_index("ix_agent_controllers_owner_id", "agent_controllers", ["owner_id"])

    op.create_table(
        "agent_controller_enrollment_codes",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.Text(), nullable=False),
        sa.Column("api_key_id", sa.Text(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("controller_id", sa.Text(), nullable=True),
        _timestamp("created_at"),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name="fk_agent_controller_enrollment_codes_tenant",
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.ForeignKeyConstraint(
            ["tenant_id", "api_key_id"],
            ["api_keys.tenant_id", "api_keys.id"],
            name="fk_agent_controller_enrollment_codes_api_key",
            ondelete="SET NULL (api_key_id)",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "controller_id"],
            ["agent_controllers.tenant_id", "agent_controllers.id"],
            name="fk_agent_controller_enrollment_codes_controller",
        ),
    )
    op.create_index(
        "ix_agent_controller_enrollment_codes_api_key_id",
        "agent_controller_enrollment_codes",
        ["api_key_id"],
    )

    op.create_table(
        "agent_definitions",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.Text(), nullable=False),
        sa.Column("controller_id", sa.Text(), nullable=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("desired_state", sa.Text(), nullable=False),
        sa.Column("definition", postgresql.JSONB(), nullable=False),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id", "agent_id", name="uq_agent_definitions_agent"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_agent_definitions_tenant"
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_definitions_agent",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "controller_id"],
            ["agent_controllers.tenant_id", "agent_controllers.id"],
            name="fk_agent_definitions_controller",
        ),
        sa.CheckConstraint(
            "desired_state IN ('running', 'stopped')",
            name="ck_agent_definitions_desired_state",
        ),
    )
    op.create_index(
        "ix_agent_definitions_controller_id", "agent_definitions", ["controller_id"]
    )
    op.create_index("ix_agent_definitions_owner_id", "agent_definitions", ["owner_id"])

    op.create_table(
        "agent_controller_operations",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("controller_id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("params", postgresql.JSONB(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("result", postgresql.JSONB(), nullable=True),
        sa.Column("created_by", sa.Text(), nullable=False),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name="fk_agent_controller_operations_tenant",
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(
            ["tenant_id", "controller_id"],
            ["agent_controllers.tenant_id", "agent_controllers.id"],
            name="fk_agent_controller_operations_controller",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_controller_operations_agent",
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "state IN ('pending', 'claimed', 'succeeded', 'failed', 'cancelled', 'expired')",
            name="ck_agent_controller_operations_state",
        ),
    )
    op.create_index(
        "ix_agent_controller_operations_controller_state",
        "agent_controller_operations",
        ["controller_id", "state"],
    )

    for table in TABLES:
        op.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
        op.execute(_create_policy(table))


def downgrade() -> None:
    for table in reversed(TABLES):
        op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{table}"')
    op.drop_index(
        "ix_agent_controller_operations_controller_state",
        table_name="agent_controller_operations",
    )
    op.drop_table("agent_controller_operations")
    op.drop_index("ix_agent_definitions_owner_id", table_name="agent_definitions")
    op.drop_index("ix_agent_definitions_controller_id", table_name="agent_definitions")
    op.drop_table("agent_definitions")
    op.drop_index(
        "ix_agent_controller_enrollment_codes_api_key_id",
        table_name="agent_controller_enrollment_codes",
    )
    op.drop_table("agent_controller_enrollment_codes")
    op.drop_index("ix_agent_controllers_owner_id", table_name="agent_controllers")
    op.drop_table("agent_controllers")
