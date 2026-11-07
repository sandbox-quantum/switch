"""room schedules: messages Switch posts to a room's agents at a set time

`room_schedules` holds one schedule per row: the agents to address, the
message, and either a one-off `run_at` or a five-field cron expression read
in an IANA timezone. `next_run_at` is when it fires next, NULL while it is
paused or finished; the partial index on it is what the due-poll reads.

The row-level-security DDL is a verbatim copy of `switch_core/db/rls_ddl.py`
as it stood when this migration was written, copied rather than imported for
the reason `265ed188ad6f` gives.

Marked `expand_only`: it only adds a table, which no earlier release reads.

Revision ID: c5a8e2f7d913
Revises: f3a8d1c6b927
Create Date: 2026-11-06 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c5a8e2f7d913"
down_revision: str | Sequence[str] | None = "f3a8d1c6b927"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"
TABLE = "room_schedules"

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
        TABLE,
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("created_by_user_id", sa.Text(), nullable=True),
        sa.Column("updated_by_user_id", sa.Text(), nullable=True),
        sa.Column("agent_ids", postgresql.JSONB(), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("schedule_type", sa.Text(), nullable=False),
        sa.Column("cron_expression", sa.Text(), nullable=True),
        sa.Column("run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("timezone", sa.Text(), nullable=False),
        sa.Column(
            "enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False
        ),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_outcome", sa.Text(), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_room_schedules_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_room_schedules_room",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name="fk_room_schedules_created_by",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["updated_by_user_id"],
            ["users.id"],
            name="fk_room_schedules_updated_by",
            ondelete="SET NULL",
        ),
        sa.CheckConstraint(
            "schedule_type IN ('once', 'cron')", name="ck_room_schedules_type"
        ),
        sa.CheckConstraint(
            "(schedule_type = 'cron' AND cron_expression IS NOT NULL "
            "AND run_at IS NULL) OR "
            "(schedule_type = 'once' AND run_at IS NOT NULL "
            "AND cron_expression IS NULL)",
            name="ck_room_schedules_timing",
        ),
    )
    op.create_index("ix_room_schedules_tenant_id", TABLE, ["tenant_id"])
    op.create_index("ix_room_schedules_room_id", TABLE, ["room_id"])
    op.create_index(
        "ix_room_schedules_next_run_at",
        TABLE,
        ["next_run_at"],
        postgresql_where=sa.text("next_run_at IS NOT NULL"),
    )
    op.execute(f'ALTER TABLE "{TABLE}" ENABLE ROW LEVEL SECURITY')
    op.execute(_create_policy(TABLE))


def downgrade() -> None:
    op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{TABLE}"')
    op.drop_table(TABLE)
