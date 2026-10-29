"""room schedules: messages Switch posts in a room at a set time

``room_schedules`` holds one row per schedule: the room, the text, a one-off
``run_at`` or a ``cron`` rule read in ``timezone``, and when it fires next.
``room_schedule_agents`` names the agents each one addresses.

Expand only: a release from before this revision never reads either table.

The row-level-security DDL is a verbatim copy of ``switch_core/db/rls_ddl.py``
as it stood when this migration was written, copied rather than imported for
the reason ``265ed188ad6f`` gives.

Revision ID: ea04f4268127
Revises: e5a9c3d71f08
Create Date: 2026-10-28 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "ea04f4268127"
down_revision: str | None = "e5a9c3d71f08"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"

_PREDICATE = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'


def _create_policy(table: str) -> str:
    return (
        f'CREATE POLICY {POLICY_NAME} ON "{table}"\n'
        f"    FOR ALL\n"
        f"    USING ({_PREDICATE})\n"
        f"    WITH CHECK ({_PREDICATE})"
    )


def upgrade() -> None:
    op.create_table(
        "room_schedules",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("author_id", sa.Text(), nullable=False),
        sa.Column("author_agent_id", sa.Text(), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cron", sa.Text(), nullable=True),
        sa.Column("timezone", sa.Text(), nullable=False),
        sa.Column("paused", sa.Boolean(), nullable=False),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_room_schedules_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_room_schedules_room",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "author_agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_room_schedules_author_agent",
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "(run_at IS NULL) <> (cron IS NULL)", name="ck_room_schedules_timing"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "tenant_id", name="uq_room_schedules_id_tenant"),
    )
    op.create_index(
        "ix_room_schedules_due",
        "room_schedules",
        ["tenant_id", "next_run_at"],
        postgresql_where=sa.text("NOT paused AND next_run_at IS NOT NULL"),
    )
    op.create_index(
        "ix_room_schedules_room", "room_schedules", ["tenant_id", "room_id"]
    )
    op.create_index(
        "ix_room_schedules_author_agent",
        "room_schedules",
        ["tenant_id", "author_agent_id"],
    )
    op.create_table(
        "room_schedule_agents",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("schedule_id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_room_schedule_agents_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "schedule_id"],
            ["room_schedules.tenant_id", "room_schedules.id"],
            name="fk_room_schedule_agents_schedule",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_room_schedule_agents_agent",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("schedule_id", "agent_id"),
    )
    op.create_index(
        "ix_room_schedule_agents_agent",
        "room_schedule_agents",
        ["tenant_id", "agent_id"],
    )
    for table in ("room_schedules", "room_schedule_agents"):
        op.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
        op.execute(_create_policy(table))


def downgrade() -> None:
    for table in ("room_schedule_agents", "room_schedules"):
        op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{table}"')
    op.drop_index("ix_room_schedule_agents_agent", table_name="room_schedule_agents")
    op.drop_table("room_schedule_agents")
    op.drop_index("ix_room_schedules_author_agent", table_name="room_schedules")
    op.drop_index("ix_room_schedules_room", table_name="room_schedules")
    op.drop_index("ix_room_schedules_due", table_name="room_schedules")
    op.drop_table("room_schedules")
